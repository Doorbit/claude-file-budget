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
| Read into conversations | 30.2M tokens over 19,298 reads |
| **Repeated in the same session** | **6.1M tokens (20%) over 5,406 reads** |
| Carried — re-sent on every later request | 10.2B (**338×**) |
| Largest single read | 17,357 tokens, one file |

Across every tool in those transcripts, file reading accounted for **60% of
everything written into context** — more than every MCP integration combined.

Two failure modes drive it, and neither is a compression problem:

**The same unchanged file is read again.** One file was read 495 times, another
549. Whenever the file has not changed since the last read, its contents are
already in the conversation; the second copy buys nothing and is then re-sent on
every following request.

**A whole large file is read when a few lines were the question.** Ten reads of
a 17,000-token file cost more than a thousand ordinary tool calls.

This is worth stating plainly because it is easy to reach for the wrong tool:
output compressors do excellent work on structured output — one such tool
measured 99% savings on `git diff` and 77% on test output — but only **2.3%** on
file reads. Source code does not compress, because there is no boilerplate to
strip. The waste is in the request, not in the representation.

## What the plugin does

**Refuses a duplicate read of an unchanged file.** Same path, same range, same
size, same mtime, within the dedupe window. The refusal says when the file was
read and how to get a different part.

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

### It refuses each file at most once

If the model asks again after a refusal, the read goes through. It has a reason
the hook cannot see — the conversation may have been compacted and the contents
genuinely lost. A guard that insists in that situation strands the session, which
is worse than the tokens it saves. Entries also expire after the dedupe window.

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
| `enforcement` | `block` | `block`, `warn` or `off`. |

## Verify it is working

```bash
node scripts/file-token-report.mjs --since 2026-09
```

Compare the repeated-read share against a period before installation.

## License

MIT
