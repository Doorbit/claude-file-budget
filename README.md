# File Read Budget

A Claude Code plugin for the largest, quietest consumer of conversation context:
reading files.

## The problem, measured

Run the included report against your own transcripts:

```bash
node scripts/file-token-report.mjs
```

On the machine this plugin was built for:

| | |
|---|---|
| Read into conversations | 30.2M tokens over 19,332 reads |
| Carried — re-sent on every later request | 10.2B (**338×**) |
| **Re-read at the same range** | **593k tokens (2%) over 615 reads** |
| Largest single read | 17,357 tokens, one file |

Across every tool in those transcripts, file reading accounted for **60% of
everything written into context** — more than every MCP integration combined.

Be careful with that 2%. An earlier version of the report counted a repeat by
path alone and produced 20%; most of that turned out to be reads of *different*
ranges of the same file, which are not duplicates and are never refused. The
honest figure for what deduplication alone can recover is the small one, and it
is an upper bound even then, because the guard also requires the file to be
unchanged.

So the refusal is the smaller half of this plugin. The larger half is the
annotation: single reads reaching 17,357 tokens, and files like `GameScreen.tsx`
read 477 times for 1.03M tokens in total. Almost none of those are literal
duplicates — they are a file being read whole, over and over, for one symbol at a
time. No refusal can fix that; only reading less can, which is what the note is
for.

Two failure modes drive the cost, and neither is a compression problem:

**The same unchanged file is read again at the same range.** Its contents are
already in the conversation, so the second copy buys nothing and is then re-sent
on every following request.

**A whole large file is read when a few lines were the question.** Ten reads of a
17,000-token file cost more than a thousand ordinary tool calls.

This is worth stating plainly because it is easy to reach for the wrong tool:
output compressors do excellent work on structured output — one such tool
measured 99% savings on `git diff` and 77% on test output — but only **2.3%** on
file reads. Source code does not compress, because there is no boilerplate to
strip. The waste is in the request, not in the representation.

## What the plugin does

**Challenges a duplicate read of an unchanged file.** Same path, same range,
same size, same mtime, within the dedupe window. The refusal says when the file
was read and how to get a different part.

**Annotates a large read** with what it is about to cost and how to ask for less.
The read always goes through — only the caller knows how much of the file the
task needs.

**Covers Bash reads too.** `sed -n '10,80p' file`, `head`, `tail` and `cat` put
the same bytes into the conversation that `Read` does, so they share one ledger:
a `sed` of a file already read is a duplicate like any other. Commands with a
pipe, a redirect or a chain are left alone — guessing at those is how a guard
starts blocking real work.

### State is per agent, not per session

A subagent's tool calls arrive with the parent's `session_id` and even the parent's
`transcript_path`, but with an `agent_id` of its own. Keying on the session alone
would pool a parent and all its subagents into one ledger, so a subagent would be
told it already has a file it has never seen — its context is separate, and the
contents are genuinely not there. Ledgers are keyed on session and agent together.

### Insisting always wins

A duplicate is refused once; if the very next call asks for the same thing again,
it goes through. The model has a reason the hook cannot see — the conversation may
have been compacted and the contents genuinely lost — and a guard that keeps
saying no strands the session, which costs more than the tokens it saves.

Refusing only once *ever* was the previous design, and it was far too weak: on a
file read 495 times it recovered a single duplicate. Challenging each duplicate
and yielding to insistence keeps the safety property while actually catching the
pattern.

## Install

```bash
claude plugin marketplace add Doorbit/claude-file-budget
claude plugin install file-budget@file-budget --scope user
```

User scope applies it to every project on the machine.

```bash
claude plugin details file-budget    # expect one PreToolUse hook, ~0 standing cost
```

## Configure

| Option | Default | Effect |
|---|---|---|
| `large_file_tokens` | 6000 | Above this, a read gets a note about its cost. |
| `dedupe_window_minutes` | 120 | How long a file counts as already-read. |
| `enforcement` | `block` | `block` refuses duplicates, `warn` only explains, `off` disables. |

## Verify it is working

```bash
node scripts/file-token-report.mjs --since 2026-09
```

Compare the repeated-read share against a period before installation.

## License

MIT
