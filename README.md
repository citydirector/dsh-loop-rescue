# dsh-loop-rescue

English · [简体中文](README.zh-CN.md) · [npm](https://www.npmjs.com/package/dsh-loop-rescue)

Stop repetitive DSH model output, prune the repetition from the committed message, and resume automatically. It catches recurring short phrases, reasoning and repeated passages of text.

Requires **DSH >=0.2.1-rc.2 <0.3.0** and **Node.js 24.9+**. Coverage includes 0.2.1-rc.3; installation does not require an alpha DSH release.

## Quick start

1. Enter `dsh-loop-rescue` in **Plugins → Add plugin**, then enable it.
2. Use this or `@mrweicodes/dsh-loop-guard`, so both do not cut the same stream.
3. The default mode rescues automatically. Use `mode: observe` to inspect detection before allowing cuts.

For a Web profile:

~~~sh
dsh plugin --profile web add dsh-loop-rescue
~~~

Stop the corresponding DSH instance before CLI changes and restart afterwards. Prefer the Plugins page on Desktop; CLI management of its desktop profile requires that installation's own CLI and the same DSH_HOME.

## Configuration

The profile's `cordis.patch.yml` stores settings under row ID `loop-rescue`:

~~~yaml
- set:
    - id: loop-rescue
      config:
        mode: rescue
        watch: both
        maxConsecutiveRescues: 3
        language: auto
~~~

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `rescue` | Prune and resume; `cut` prunes only, `observe` logs only |
| `watch` | `both` | Watch `reasoning`, `text` or both |
| `marker` | `true` | Leave a marker at the cut |
| `maxConsecutiveRescues` | `3` | Consecutive rescue cap; normal calls reset it |
| `stallCalls` | `3` | Nudge after reasoning-only calls; 0 disables |
| `stallMinReasoningChars` | `1024` | Minimum reasoning length counted as a stall |
| `retryTemperature` / `retryReasoningEffort` | Unset | Optional sampling overrides after rescue |
| `retryRequests` | `1` | Number of requests using those overrides |
| `language` | `auto` | `auto`, `zh` or `en` |

The `detector` object adjusts thresholds; defaults usually suffice. See [advanced documentation](docs/advanced.md) for full examples, detection rules and offline tools.

## Updates

Install by npm name. Use DSH's version list when available. Otherwise, stop DSH and run:

~~~sh
dsh plugin --profile web add dsh-loop-rescue@latest
~~~

To migrate a GitHub dependency, back up the profile's `cordis.patch.yml`, remove the old package, add the npm name, and verify saved settings. Maintainer publishing instructions are in [PUBLISHING.md](PUBLISHING.md).

## Limitations

- The committed message contains the pruned content; redrawing already streamed output depends on the DSH front end.
- Open tool calls prevent a cut, keeping incomplete arguments from executing.
- Repeated tool use across separate steps is outside the detector's scope.
- Saved history is not rewritten automatically. Close DSH and retain backups before offline cleaning.
- Sampling overrides require support from the model adapter.

## Development

~~~sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
~~~

CI covers DSH 0.2.1-rc.3 and an alpha runtime. Entry point: [src/index.js](src/index.js); detector: [src/detector.js](src/detector.js).

## License

[MIT](LICENSE)
