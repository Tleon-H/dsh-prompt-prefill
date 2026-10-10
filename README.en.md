# dsh-prompt-prefill

[简体中文](README.md) | **English**

[![npm](https://img.shields.io/npm/v/dsh-prompt-prefill)](https://www.npmjs.com/package/dsh-prompt-prefill)
[![test](https://github.com/Tleon-H/dsh-prompt-prefill/actions/workflows/test.yml/badge.svg)](https://github.com/Tleon-H/dsh-prompt-prefill/actions/workflows/test.yml)

A DeepSeek Harness (DSH) desktop plugin that adds two small features to the input box:

- **→ / Tab: accept a suggested next prompt.** When the agent finishes replying, a light gray suggestion appears in the empty input box, guessing what you are likely to say next based on the recent conversation. Press `Tab` or `→` to put it into your draft.
- **↑: recall your last message.** With the input box empty, press `↑` to fill in the last message you sent in this session.

Both only fill the input box. **Nothing is ever sent automatically.**

Tested on DSH desktop **0.2.0-rc.2** (other versions are untested).

## Install

```powershell
dsh plugin --profile desktop add dsh-prompt-prefill
```

After installing, **fully quit DSH (including the tray icon) and reopen it**. It is best to quit DSH before installing too, otherwise the command waits for DSH to release its file lock.

- Latest code from the repository: `dsh plugin --profile desktop add github:Tleon-H/dsh-prompt-prefill`
- Web version of DSH: replace `--profile desktop` with your own profile (usually `--profile web`)
- Update: `remove` and `add` again, then restart DSH
- Uninstall: `dsh plugin --profile desktop remove dsh-prompt-prefill`

## Usage

- When a reply finishes and the input box is empty, a gray suggestion appears within a few seconds. Press `Tab` / `→` to accept, `Escape` to dismiss; it hides as soon as you start typing.
- Just opening or browsing a session never calls the model. No suggestion is generated while the agent is replying, or when the last turn failed or was aborted.
- When the conversation has no obvious next step, the model may return no suggestion, and nothing is shown.
- The plugin does not intercept keys with modifiers, during IME composition, or when the input box is not focused.

## Configuration

Settings live in [cordis.patch.yml](cordis.patch.yml). The most useful ones:

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `provider` / `model` | `''` | Pin a model for generating suggestions; both must be set. Empty means follow the current session |
| `timeoutMs` | `20000` | Timeout per generation (ms) |
| `maxRecentTurns` | `3` | Number of recent messages sent to the model |

See the comments in `cordis.patch.yml` for the rest.

The plugin reuses the models and API keys you already configured in DSH and needs no credentials of its own. If your chat model is slow or always reasons, or you use a plugin that switches models automatically, pin a fast non-reasoning model, for example:

```yaml
        provider: 'workbuddy'
        model: 'glm-5.3-flash'
```

Only the text of the last few messages is sent to the model. Common key and token formats are masked first, but this pattern-based masking cannot catch every secret.

## Notes

- The gray text is an overlay aligned with the input box; very long suggestions may be cut off visually, but accepting still inserts the full text.
- `↑` only recalls the most recent message, text only (no image attachments).
- Do not install alongside other plugins that also intercept `Tab` / `→` / `↑` (see [similar plugins](docs/similar-plugins.md)).

## More docs (Chinese)

- [Troubleshooting & diagnostics](docs/troubleshooting.md)
- [Developer notes](docs/development.md): how it works, pitfalls, tests
- [Changelog](CHANGELOG.md)

This is a small personal project. Feedback via [issues](https://github.com/Tleon-H/dsh-prompt-prefill/issues) is welcome, but replies are not guaranteed.

## License

MIT
