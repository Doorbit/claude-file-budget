#!/usr/bin/env node
/**
 * PreToolUse guard for large file reads.
 *
 * Reading files is the largest single consumer of conversation context, and
 * almost all of it is first reads: a whole large file pulled in for one symbol,
 * then re-sent with every following request for the rest of the session. This
 * hook says what such a read is about to cost, and lets it through. Only the
 * caller knows how much of the file the task needs.
 *
 * It used to also refuse duplicate reads. That was built on a measurement error
 * — the report counted a repeat by path alone, so reads of different ranges of
 * the same file were counted as waste. Corrected, the recoverable share fell
 * from 20% to 2%, and in practice to almost nothing: over two days of real use
 * the refusals saved about 6,000 tokens, and the apparent duplicates that were
 * missed turned out to be files that had genuinely changed between reads — a
 * growing log being polled, images being regenerated. A rule that expensive to
 * get right, for that little, is not worth keeping. It is gone, along with the
 * ledger it needed.
 *
 * Read only, deliberately. Covering Bash meant running this process on every
 * Bash call, and only 2.6% of them read a file — the rest paid ~38ms for
 * nothing.
 */

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/** A misconfigured number must not disable the hook silently: Number('abc') is
 *  NaN, and every comparison against NaN is false. */
function num(name, fallback) {
  const parsed = Number(process.env[`CLAUDE_PLUGIN_OPTION_${name}`]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MODE = (process.env.CLAUDE_PLUGIN_OPTION_ENFORCEMENT || 'on').toLowerCase();
const LARGE_TOKENS = num('LARGE_FILE_TOKENS', 6000);

// Byte count says nothing about what these cost to read: images are billed by
// pixel area, PDFs and notebooks are paged. Estimating from size would produce
// confidently wrong numbers, which teaches the model to ignore the accurate ones.
const OPAQUE = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.ipynb', '.zip', '.gz', '.tar', '.mp4', '.mov', '.mp3', '.wav',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.heapsnapshot', '.wasm',
]);

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
if (!input || MODE === 'off' || input.tool_name !== 'Read') process.exit(0);

const path = input.tool_input?.file_path;
// A ranged read is already the behaviour this hook is asking for.
if (!path || input.tool_input?.offset !== undefined || input.tool_input?.limit !== undefined) {
  process.exit(0);
}
if (OPAQUE.has(extname(path).toLowerCase())) process.exit(0);

let size;
try {
  const stat = statSync(path);
  if (!stat.isFile()) process.exit(0);
  size = stat.size;
} catch {
  process.exit(0); // a file we cannot stat is not ours to judge
}

const estimate = Math.round(size / 4);
if (estimate <= LARGE_TOKENS) process.exit(0);

// Informational only: deliberately no permissionDecision. A hook that exists to
// count tokens has no business granting or withholding a permission.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext:
      `${path} is about ${estimate.toLocaleString('en-US')} tokens. Reading it whole puts all of ` +
      'that in the conversation for the rest of the session, re-sent on every following request. ' +
      'If you are after one symbol or one section, grep for it and read the surrounding range ' +
      'with offset and limit instead.',
  },
}));
