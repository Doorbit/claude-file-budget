#!/usr/bin/env node
/**
 * PreToolUse guard for file reads.
 *
 * Reading files is the largest single consumer of conversation context — larger
 * than any tool integration — and it has two failure modes that no output
 * compressor can address, because the problem is the request rather than the
 * representation:
 *
 *   1. The same unchanged file is read again. Its contents are already in the
 *      conversation, so the second copy buys nothing and is then re-sent with
 *      every following request for the rest of the session.
 *   2. A whole large file is read when a few lines were the question.
 *
 * The guard refuses (1), because an unchanged file is provably redundant, and
 * only annotates (2), because only the caller knows how much of the file the
 * task needs. It covers Bash file reads as well, since sed, head and tail put
 * exactly the same bytes into the conversation as Read does.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MODE = (process.env.CLAUDE_PLUGIN_OPTION_ENFORCEMENT || 'block').toLowerCase();
const LARGE_TOKENS = Number(process.env.CLAUDE_PLUGIN_OPTION_LARGE_FILE_TOKENS || 6000);
const WINDOW_MS = Number(process.env.CLAUDE_PLUGIN_OPTION_DEDUPE_WINDOW_MINUTES || 120) * 60_000;

function emit(payload) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', ...payload },
  }));
  process.exit(0);
}
const pass = () => process.exit(0);
/** Informational only: deliberately no permissionDecision. A hook that exists to
 *  count tokens has no business granting a permission the user might otherwise
 *  be asked about. */
function note(text) {
  emit({ additionalContext: text });
}
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

const sliceKey = (offset, limit) =>
  offset === undefined && limit === undefined ? 'whole' : `${offset ?? 0}+${limit ?? 'end'}`;

/** Which file is this call about, and which slice of it? */
function target() {
  if (input.tool_name === 'Read') {
    return { path: args.file_path, slice: sliceKey(args.offset, args.limit), via: 'Read' };
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
    // `head -n 50` is the same content as `sed -n '1,50p'`, so give it the same
    // key. `tail -n 50` is the opposite end of the file and must not collide
    // with it — counting from the end needs a key of its own.
    slice = headTail[1] === 'head' ? sliceKey(1, Number(headTail[2])) : `last${headTail[2]}`;
  } else {
    slice = sliceKey(undefined, undefined);
  }
  return { path, slice, via: cmd.trim().split(/\s+/)[0] };
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

const ledgerDir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'file-budget');
const ledgerFile = join(ledgerDir, `reads-${String(input.session_id || 'nosession').replace(/[^\w.-]/g, '_')}.json`);
let ledger = {};
try {
  ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
} catch {
  /* first read of the session */
}

const now = Date.now();
const key = `${t.path}::${t.slice}`;
const prev = ledger[key];
const unchanged = prev && prev.mtime === stat.mtimeMs && prev.size === stat.size;
const fresh = prev && now - prev.at < WINDOW_MS;

function remember(extra = {}) {
  ledger[key] = { mtime: stat.mtimeMs, size: stat.size, at: now, ...extra };
  try {
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(ledgerFile, JSON.stringify(ledger));
  } catch {
    /* without a ledger there is no dedupe, which is acceptable */
  }
}

// A denial is only ever issued once per file. If the model asks again it has a
// reason the hook cannot see — the conversation may have been compacted and the
// contents genuinely lost — and refusing a second time would strand it.
if (unchanged && fresh && !prev.denied) {
  remember({ denied: true });
  const when = new Date(prev.at).toTimeString().slice(0, 8);
  refuse(
    `You already read ${t.path} at ${when} and it has not changed since (same size, same mtime), ` +
    'so its contents are still in this conversation — reading it again adds a second copy that is ' +
    'then re-sent with every following request. Scroll back for it. If you need a different part, ' +
    'read that range with offset and limit, or grep for the symbol. If you genuinely no longer ' +
    'have the contents, ask again and this will go through.',
  );
}

remember();

const estimate = Math.round(stat.size / 4);
if (t.slice === 'whole' && estimate > LARGE_TOKENS && !prev) {
  note(
    `${t.path} is about ${estimate.toLocaleString('en-US')} tokens. Reading it whole puts all of ` +
    'that in the conversation for the rest of the session. If you are after one symbol or one ' +
    'section, grep for it and read the surrounding range with offset and limit instead.',
  );
}

pass();
