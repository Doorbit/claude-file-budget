# Large Read Notice

A Claude Code plugin that says what a large file read is about to cost, before it
happens.

## Why

Reading files is the largest single consumer of conversation context — in the
transcripts this was built from, **60% of everything written into context**, more
than every MCP integration combined. Anything a tool returns is re-sent with every
following request, so a 17,000-token file read in the first minute is paid for
again on every turn after it.

Almost all of that is *first* reads: a whole large file pulled in for one symbol.
One file was read 477 times for 1.03M tokens in total — hardly any of them literal
duplicates, just the same file read whole, over and over, for one thing at a time.

This is not a compression problem. An output compressor measured 99% savings on
`git diff` and 77% on test output, but only **2.3%** on file reads: source code has
no boilerplate to strip. The waste is in asking for the whole file, and only the
caller can decide not to.

So this plugin does one thing. Before a whole-file `Read` that will cost more than
the threshold, it puts the number in front of the model:

> `src/screens/GameScreen.tsx` is about 17,357 tokens. Reading it whole puts all of
> that in the conversation for the rest of the session, re-sent on every following
> request. If you are after one symbol or one section, grep for it and read the
> surrounding range with offset and limit instead.

The read always goes through. The hook never refuses anything, never grants a
permission, and writes nothing to disk.

## What it used to do, and why it stopped

It also refused duplicate reads of unchanged files. That was built on a
measurement error: the report counted a repeat by path alone, so reads of
*different ranges* of the same file counted as waste. Corrected to count by path
and range, the recoverable share fell from 20% to 2% — and in two days of real use
the refusals saved about 6,000 tokens.

Worse, the duplicates it did not catch turned out not to be duplicates at all: a
growing task-output file being polled, and images being regenerated between reads.
The rule was right to let them through, which left almost nothing for it to do.

Three review rounds went into getting that rule correct — the refusal alternated
forever at one point, and `tail` was refused as a duplicate of `head` at another.
For 0.2%, it was not worth the ways it could go wrong. It is gone, along with the
ledger, the concurrency handling and the per-agent state it needed.

`Read` only, for the same reason: covering Bash meant running a process on every
Bash call, and only 2.6% of them read a file.

## Install

```bash
claude plugin marketplace add Doorbit/claude-file-budget
claude plugin install file-budget@file-budget --scope user
```

| Option | Default | Effect |
|---|---|---|
| `large_file_tokens` | 3000 | Reads estimated above this get the note. The measured average for a whole-file read is ~2,150 tokens, so 3000 catches the upper half. |
| `enforcement` | `on` | `on` or `off`. Nothing is ever refused. |

## Measuring

```bash
node scripts/file-token-report.mjs [--since YYYY-MM]
```

Reports what file reading costs you across your own transcripts: total, carried,
per entry point, per file, and the largest single reads.

It also reads the hook's own log of firings. That log exists because
`additionalContext` never reaches the transcript: from the outside there is no way
to tell a hook that fires ten times from one that is silently broken, which is
exactly the position this plugin was in before the log was added. Only firings are
written, so it stays off the hot path.

Two numbers decide whether to keep this installed. **Notices fired** says the hook
is working at all. **Average tokens per `Read`** says whether it changes anything —
if that does not fall over a few weeks while notices keep firing, the model is
reading whole files regardless and you should turn the plugin off.

## License

MIT
