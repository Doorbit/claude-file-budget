#!/usr/bin/env node
/**
 * PreToolUse guard for file reads.
 *
 * Reading files is the largest single consumer of conversation context, and it
 * has two failure modes that no output compressor can address, because the
 * problem is the request rather than the representation:
 *
 *   1. The same unchanged file is read again. Its contents are already in the
 *      conversation, so the second copy buys nothing and is then re-sent with
 *      every following request for the rest of the session.
 *   2. A whole large file is read when a few lines were the question.
 *
 * The guard challenges (1) and only annotates (2), because only the caller
 * knows how much of the file the task needs. It covers Bash file reads as well,
 * since sed, head, tail and cat put exactly the same bytes into the
 * conversation as Read does.
 *
 * Insisting always wins. A duplicate read is refused once; if the very next
 * call asks for the same thing again, it goes through. The model has a reason
 * the hook cannot see — the conversation may have been compacted and the
 * contents genuinely lost — and a guard that keeps saying no strands the
 * session, which costs more than the tokens. Refusing only once *ever* was the
 * previous design and it was far too weak: on a file read 495 times it
 * recovered a single duplicate.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

/** A misconfigured number must not disable the guard silently. Number('abc') is
 *  NaN, and every comparison against NaN is false, so an unvalidated setting
 *  turns every rule into a no-op while the hook still exits cleanly. */
function num(name, fallback) {
  const parsed = Number(process.env[`CLAUDE_PLUGIN_OPTION_${name}`]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MODE = (process.env.CLAUDE_PLUGIN_OPTION_ENFORCEMENT || 'block').toLowerCase();
const LARGE_TOKENS = num('LARGE_FILE_TOKENS', 6000);
const WINDOW_MS = num('DEDUPE_WINDOW_MINUTES', 120) * 60_000;

// Byte count says nothing about what these cost to read: images are billed by
// pixel area, PDFs and notebooks are paged. Estimating from size would produce
// confidently wrong numbers, which teaches the model to ignore the accurate ones.
const OPAQUE = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz',
  '.pdf', '.ipynb', '.zip', '.gz', '.tar', '.mp4', '.mov', '.mp3', '.wav',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.heapsnapshot', '.wasm',
]);

function emit(payload) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', ...payload },
  }));
  process.exit(0);
}
const pass = () => process.exit(0);

/** Informational only: deliberately no permissionDecision. A hook that exists
 *  to count tokens has no business granting a permission the user might
 *  otherwise be asked about. */
const note = (text) => emit({ additionalContext: text });

function refuse(reason) {
  if (MODE === 'warn') emit({ additionalContext: reason });
  emit({ permissionDecision: 'deny', permissionDecisionReason: reason });
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  pass();
}
if (!input || MODE === 'off') pass();

const args = input.tool_input || {};

// Read's offset is a line number and both conventions have to agree, or the
// same fifty lines land in two different ledger keys depending on how they were
// asked for. Everything is normalised to 1-based here.
const sliceKey = (offset, limit) =>
  offset === undefined && limit === undefined ? 'whole' : `${offset ?? 1}+${limit ?? 'end'}`;

/** Which file is this call about, and which slice of it? */
function target() {
  if (input.tool_name === 'Read') {
    return { path: args.file_path, slice: sliceKey(args.offset, args.limit) };
  }
  if (input.tool_name !== 'Bash') return null;
  const cmd = String(args.command || '');
  // Anything with a pipe, redirect or chain is doing more than reading a file,
  // and guessing at it is how a guard starts blocking legitimate work.
  if (/[|><]|&&|\|\||;|\$\(/.test(cmd)) return null;
  const sed = cmd.match(/^\s*sed\s+-n\s+(?:'|")?(\d+),(\d+)p(?:'|")?\s+(\S+)\s*$/);
  const headTail = cmd.match(/^\s*(head|tail)\s+-n\s+(\d+)\s+(\S+)\s*$/);
  const whole = cmd.match(/^\s*cat\s+(\S+)\s*$/);
  const m = sed ?? headTail ?? whole;
  if (!m) return null;
  const path = m[m.length - 1].replace(/^['"]|['"]$/g, '');
  if (!path.startsWith('/')) return null; // relative paths are ambiguous across cwds

  let slice;
  if (sed) {
    slice = sliceKey(Number(sed[1]), Number(sed[2]) - Number(sed[1]) + 1);
  } else if (headTail) {
    // `head -n 50` is the same fifty lines as `sed -n '1,50p'` and as
    // `Read(limit: 50)`, so all three share a key. `tail -n 50` is the opposite
    // end of the file and must not collide with them.
    slice = headTail[1] === 'head' ? sliceKey(1, Number(headTail[2])) : `last${headTail[2]}`;
  } else {
    slice = sliceKey(undefined, undefined);
  }
  return { path, slice };
}

const t = target();
if (!t?.path) pass();

let stat;
try {
  stat = statSync(t.path);
} catch {
  pass(); // a file we cannot stat is not ours to judge
}
if (!stat.isFile()) pass();

/**
 * A subagent's tool calls arrive with the parent's session_id and even the
 * parent's transcript_path, but with an agent_id of its own. Keying state by
 * the session alone therefore pools the parent and every subagent into one
 * ledger — so a subagent would be told it already has a file it has never seen.
 * Each agent has its own context, so each agent gets its own ledger.
 */
function ledgerKey(source) {
  const session = String(source.session_id || 'nosession');
  const agent = source.agent_id ? `-agent-${source.agent_id}` : '';
  return `${session}${agent}`.replace(/[^\w.-]/g, '_');
}

const now = Date.now();
const ledgerDir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'file-budget');
const ledgerFile = join(ledgerDir, `reads-${ledgerKey(input)}.json`);

function load() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  } catch {
    return {}; // no ledger yet, or a torn read from a concurrent writer
  }
  const live = {};
  for (const [k, v] of Object.entries(raw)) {
    // A missing or non-numeric `at` would survive every expiry pass and never
    // be comparable, leaving a key that can neither be collected nor matched.
    if (v && Number.isFinite(v.at) && now - v.at < WINDOW_MS) live[k] = v;
  }
  return live;
}

const key = `${t.path}::${t.slice}`;
const prev = load()[key];
const unchanged = prev && prev.mtime === stat.mtimeMs && prev.size === stat.size;

/**
 * Claude Code issues several tool calls in one block, so hook processes run
 * concurrently against this file. Re-read immediately before writing so a
 * neighbour's entry is merged rather than dropped, and rename into place so a
 * concurrent reader never sees a half-written file.
 */
function remember(entry) {
  const merged = { ...load(), [key]: entry };
  try {
    mkdirSync(ledgerDir, { recursive: true });
    const tmp = `${ledgerFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged));
    renameSync(tmp, ledgerFile);
  } catch {
    /* without a ledger there is no dedupe, which is acceptable */
  }
}

const base = { mtime: stat.mtimeMs, size: stat.size, at: now };

if (unchanged) {
  if (prev.pendingDenial) {
    // The model asked again after being refused. It knows something the hook
    // does not; let it through and start over.
    remember(base);
    pass();
  }
  remember({ ...base, pendingDenial: true });
  const when = new Date(prev.at).toTimeString().slice(0, 8);
  refuse(
    `You already read ${t.path} at ${when} and it has not changed since (same size, same mtime), ` +
    'so its contents are still in this conversation — reading it again adds a second copy that is ' +
    'then re-sent with every following request. Scroll back for it. If you need a different part, ' +
    'read that range with offset and limit, or grep for the symbol. If you genuinely no longer ' +
    'have the contents, ask once more and this will go through.',
  );
}

remember(base);

// Noted on every large read, not just the first. The read-edit-read-again cycle
// costs the same seventeen thousand tokens each time round, and a sixty-token
// note is not worth rationing against that.
const estimate = Math.round(stat.size / 4);
if (
  t.slice === 'whole' &&
  estimate > LARGE_TOKENS &&
  !OPAQUE.has(extname(t.path).toLowerCase())
) {
  note(
    `${t.path} is about ${estimate.toLocaleString('en-US')} tokens. Reading it whole puts all of ` +
    'that in the conversation for the rest of the session. If you are after one symbol or one ' +
    'section, grep for it and read the surrounding range with offset and limit instead.',
  );
}

pass();
