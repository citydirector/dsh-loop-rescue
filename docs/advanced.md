# Detection and offline session tools

[Back to the README](../README.md)

## How it works

When the agent loop assembles an `assistant/message`, each block's final content comes from the `block-end` payload, not from the deltas streamed before it. The plugin wraps the model call in the `llm/stream` waterfall:

1. It runs a streaming detector on every reasoning and text block.
2. On a hit it closes every open block: the looping block is replaced by its content **pruned back to where the loop started** (optionally with a one-line marker), and the stream ends with `stop`.
3. The message written to the log holds only the useful content before the loop. The raw stream is still kept in full in the event's `stream` record, where the trajectory view can show it.
4. Once the turn has really ended (`whenIdle()`), it sends a resume message with a correction via `followup()`.
5. The first N requests after a resume can use a different set of sampling parameters.
6. After the cap on back-to-back rescues it stops resuming and leaves a note.

Why not edit the session afterwards: an `assistant/message` cannot carry `sourceEventSeqs`, so the session surface's replace operation cannot swap one assistant message for another. Pruning at `block-end` is the only way that keeps message roles and tool-call pairing intact.

### Detection rules

| Rule | Catches | Prunes from |
|---|---|---|
| Phrase pool `pool` | ≥75% of the last 30 sentences are a handful of recurring short phrases (in any order) | Back to where that batch of phrases first appeared |
| Verbatim cycle `cycle` | The tail is the same text repeated verbatim, period 16–4000 chars, ≥3 repeats, ≥600 chars in total | Keeps the first copy, prunes from the second |

Guarding against false positives:

- A Chinese full stop always ends a sentence; an English period only when followed by whitespace.
- Symbol-only lines (`|---|`, `}`) are not counted.
- List items, table rows and quote lines in the text are not counted.
- The inside of ``` code blocks in the text is skipped entirely.
- The phrase pool needs at least two different phrases rotating.
- It never cuts while an open block holds a tool call: closing a half-written tool call would make the host run it with incomplete arguments.

## Offline scan

Replay past sessions through the same detector the plugin uses, to see where it would cut:

```powershell
node tools/scan-session.mjs <session file or directory>          # hits only
node tools/scan-session.mjs <session file or directory> --all    # hits and misses
node tools/scan-session.mjs <session file> --json
```

Reads plain jsonl and zstd-compressed session files (zstd needs Node 22.15+). The script only depends on `src/detector.js` and runs on plain node.

## Cleaning loops already in the history

The plugin only stops new loops; loops already committed to the history keep being imitated by the model. What DSH sends the model is a frozen projection of the session log, which a plugin cannot change, so the session files have to be cleaned offline **with DSH fully closed**. This works for old sessions that never had the plugin too.

The recommended tool is [dsh-session-manager](https://github.com/citydirector/dsh-session-manager) (`dsm loops`, a single-file exe on Windows): the same detection rules, plus upgrading, archiving and repairing broken sessions.

This repository also ships a lightweight script (Node 22.15+, v4 sessions only):

```powershell
node tools/clean-session.mjs            # list sessions with loops, pick by number; Enter = newest
node tools/clean-session.mjs --dry-run  # show what would change
node tools/clean-session.mjs --undo     # restore from the backup
```

- On Windows you can also double-click `tools\clean-session.cmd`, or drop a session folder onto it; if it cannot find the data directory, pass `--data <data directory>`.
- Only matching `assistant/message` events change: text and reasoning are cut back to where the loop started, `data.stream` is cut to match, and the message's `source.replayState` is removed. Every other line stays byte-for-byte the same.
- It backs up to `<data directory>\sessions-loop-rescue-backup\` first, and refuses while DSH is running (`--force` skips that check; not recommended).
- Versions before 2026-10-17 read only the first frame of a compressed log and wrote the result as a single frame, which DSH treats as corrupt and hides. That is fixed; `dsm repair` brings hidden sessions back.
