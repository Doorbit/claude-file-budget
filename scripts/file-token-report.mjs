#!/usr/bin/env node
/**
 * Reports what reading files costs you, measured from Claude Code's own
 * transcripts rather than estimated.
 *
 *   node scripts/file-token-report.mjs [--since YYYY-MM] [--project <substring>]
 *
 * Two numbers are worth acting on. "Repeated" is the volume spent re-reading a
 * file already read in the same session — provably redundant whenever the file
 * did not change. "Carried" is the same tokens re-sent on every later request,
 * which is what actually fills a context window.
 */

import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const SINCE = opt('since');
const PROJECT = opt('project');
const ROOT = join(homedir(), '.claude', 'projects');

// Bash commands that put file contents into the conversation exactly the way
// Read does. cat is included because it is the same act by another name.
const READERS = /^\s*(sed|head|tail|cat|less|more)\b/;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

const byTool = new Map();
const byFile = new Map();
let firstTok = 0, firstN = 0, repeatTok = 0, repeatN = 0, carried = 0, biggest = [];

const bump = (map, key, tokens) => {
  const row = map.get(key) ?? { n: 0, tokens: 0 };
  row.n++; row.tokens += tokens; map.set(key, row);
};

for (const project of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  if (PROJECT && !project.name.includes(PROJECT)) continue;
  for (const file of walk(join(ROOT, project.name))) {
    if (statSync(file).size === 0) continue;
    const pending = new Map();
    const seen = new Set();
    const events = [];
    let turn = 0;
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (SINCE && typeof rec.timestamp === 'string' && rec.timestamp.slice(0, 7) < SINCE) continue;
      if (rec.type === 'assistant') turn++;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === 'tool_use') { pending.set(c.id, [c.name, c.input ?? {}]); continue; }
        if (c?.type !== 'tool_result') continue;
        const entry = pending.get(c.tool_use_id);
        if (!entry) continue;
        const [name, input] = entry;

        let path = null;
        if (name === 'Read') path = input.file_path ?? null;
        else if (name === 'Bash' && READERS.test(String(input.command ?? ''))) {
          const parts = String(input.command).trim().split(/\s+/);
          path = parts[parts.length - 1]?.replace(/^['"]|['"]$/g, '') ?? null;
          if (path && !path.startsWith('/')) path = null;
        }
        if (!path) continue;

        const body = c.content;
        let tokens = 0;
        if (typeof body === 'string') tokens = Math.round(body.length / 4);
        else if (Array.isArray(body)) {
          for (const part of body) if (part?.type === 'text') tokens += Math.round((part.text ?? '').length / 4);
        }

        bump(byTool, name === 'Read' ? 'Read' : String(input.command).trim().split(/\s+/)[0], tokens);
        // Keyed on the full path: basenames merge every index.ts and every
        // CLAUDE.md in a monorepo into one row, which turns a handful of reads
        // of many files into a fake duplicate-read problem.
        bump(byFile, path, tokens);
        // Counted per path AND range, matching how the guard keys its ledger.
        // It still cannot see mtime, so a read after an edit counts here and
        // would not be refused — this is an upper bound on what is recoverable.
        const range = name === 'Read'
          ? `${input.offset ?? 1}+${input.limit ?? 'end'}`
          : String(input.command).trim();
        const seenKey = `${path}::${range}`;
        if (seen.has(seenKey)) { repeatTok += tokens; repeatN++; } else { seen.add(seenKey); firstTok += tokens; firstN++; }
        if (tokens > 6000) biggest.push([tokens, path]);
        events.push([turn, tokens]);
      }
    }
    for (const [at, tokens] of events) carried += tokens * (turn - at);
  }
}

const n = (x) => x.toLocaleString('en-US');
const total = firstTok + repeatTok;
console.log(`\nFile read report${SINCE ? ` (since ${SINCE})` : ''}${PROJECT ? ` [project ~ ${PROJECT}]` : ''}`);
console.log(`  read into conversations   ${n(total)} tokens from ${n(firstN + repeatN)} reads`);
console.log(`  first time                ${n(firstTok)} (${Math.round((firstTok / Math.max(total, 1)) * 100)}%) over ${n(firstN)} reads`);
console.log(`  repeated, same range      ${n(repeatTok)} (${Math.round((repeatTok / Math.max(total, 1)) * 100)}%) over ${n(repeatN)} reads
                            (upper bound: a read after an edit counts here but is never refused)`);
console.log(`  carried (re-sent)         ${n(carried)}  ->  ${(carried / Math.max(total, 1)).toFixed(0)}x`);

const top = (map, k) => [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, k);
console.log('\n  entry point            reads       tokens     avg');
for (const [name, r] of top(byTool, 8))
  console.log(`  ${name.padEnd(22)}${String(r.n).padStart(6)}${n(r.tokens).padStart(13)}${n(Math.round(r.tokens / r.n)).padStart(8)}`);

console.log('\n  file                                              reads       tokens');
for (const [path, r] of top(byFile, 10))
  console.log(`  ${path.slice(-48).padEnd(49)}${String(r.n).padStart(6)}${n(r.tokens).padStart(13)}`);

if (biggest.length) {
  biggest.sort((a, b) => b[0] - a[0]);
  console.log('\n  single reads over 6k tokens');
  for (const [tokens, path] of biggest.slice(0, 6)) console.log(`  ${n(tokens).padStart(9)}  ${path.slice(-64)}`);
}
console.log('');
