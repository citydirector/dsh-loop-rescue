# dsh-loop-rescue

[English](README.md) · [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/tag/citydirector/dsh-loop-rescue?sort=semver&label=release)](https://github.com/citydirector/dsh-loop-rescue/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![DSH plugin](https://img.shields.io/badge/DSH%20plugin-%E2%89%A50.2.1--rc.2-blue)](https://github.com/topics/dsh-plugin)

A loop-rescue plugin for DSH (DeepSeek Harness). When the model falls into repetition (`Now. / OK. / Emit. / Producing.` rotations, the same paragraph over and over), it cuts the stream from the inside, **prunes the loop out of what gets written to the session log**, and resumes automatically.

The difference from a plain cut-off: the interrupted message that goes into the next turn's context **contains no loop**, so the model never re-reads its own repetition and carries on repeating.

Requires **DSH 0.2.1-rc.2 or newer 0.2.x**. Pure JS, no build step.

## npm installation and updates

The plugin runs on DSH 0.2.1, including 0.2.1-rc.3. Use the Plugins page version list when your DSH provides it. Otherwise, stop DSH and run `dsh plugin --profile web add dsh-loop-rescue@latest` (use `desktop` instead of `web` for Desktop), then restart. GitHub Actions publishing does not require an alpha DSH runtime.

Requires DSH 0.2.1-rc.2 or a newer 0.2.x and Node.js 24.9+. Enter `dsh-loop-rescue` in **Plugins → Add plugin**, or run:

```sh
dsh plugin --profile web add dsh-loop-rescue
```

For an existing GitHub installation, back up the profile's `cordis.patch.yml`, remove the old package in Plugins, and add the npm package above in the same profile. Keep the configuration row IDs and verify the saved settings after reinstalling. Subsequent updates use DSH's version list and update operation. Updates are handled entirely by DSH.

## Quick start

Use this **or** `@mrweicodes/dsh-loop-guard`, not both: with both on, loops get cut twice.

1. **Install**: sidebar **Plugins** → Add plugin, and give it
   ```
   dsh-loop-rescue
   ```
   Switch it on.
2. The defaults work as they are. To watch before it acts, set `mode` to `observe` (see Configuration).

From the command line:

```powershell
dsh plugin --profile web remove @mrweicodes/dsh-loop-guard
dsh plugin --profile web add dsh-loop-rescue
```

Restart `dsh web` after a command-line install. No pnpm build scripts need approving.

## Configuration

The defaults work as they are. To change them, write to the profile's `cordis.patch.yml`:

```yaml
- set:
    - id: loop-rescue
      config:
        mode: rescue              # rescue: cut + prune + resume | cut: cut + prune | observe: log only
        watch: both               # both | reasoning | text
        marker: true              # leave a "〔N chars of repeated reasoning removed〕" line where it pruned
        maxConsecutiveRescues: 3  # cap on back-to-back rescues; one normal call resets it
        stallCalls: 3             # nudge after this many reasoning-only calls with no output; 0 = off
        stallMinReasoningChars: 1024
        retryTemperature: 1.0     # temperature for the resume request; unset = unchanged
        retryReasoningEffort: low # reasoning effort for the resume request; unset = unchanged
        retryRequests: 1          # how many requests after a resume use the two settings above
        language: auto            # auto | zh | en
        detector:                 # detection thresholds; rarely need changing
          poolWindow: 30
          poolMinCoverage: 0.75
          cycleMinChars: 600
```

Consider running `mode: observe` for a day or two first, check that every `loop-rescue: ... loop detected` line in the log is a real loop, then switch to `rescue`.

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

## Known limitations

- Loop text already streamed into the chat is replaced by the pruned version once the message is committed, but exactly how it redraws depends on the DSH front-end version.
- Loops that span steps (every step is "say a line → call the same tool") are out of scope; that is the job of the built-in `guard/repeat-tool-reminder`.
- `retryTemperature` needs an adapter that supports temperature. DSH has no generic field for Ollama's repetition penalty and similar parameters, so they cannot be set from here.

## Development

```bash
npm install
npm test
```

## Related projects

- [dsh-remote-access-proxy](https://github.com/citydirector/dsh-remote-access-proxy): Use DSH from your phone, tablet, or another computer
- [deepinfra-fusion-proxy](https://github.com/citydirector/deepinfra-fusion-proxy): DeepInfra Standard / Flex switching with automatic fallback, per session
- [dsh-session-manager](https://github.com/citydirector/dsh-session-manager): Offline session manager: upgrade, archive, trash, loop cleanup, broken-tail repair

## License

[MIT](LICENSE)
