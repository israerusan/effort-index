# Effort Index

**Measure the editing time and revision effort behind every note, then resurface the expensive ones you stopped reading.**

Your vault does not tell you what anything cost. A note you rewrote seven times over three months looks exactly like a note you pasted in and never touched again. Effort Index measures the difference — and then shows you the notes you paid the most for and have not opened since.

Part of the **Second Read** suite (Note Decay, Standing Questions, Effort Index, Prior Art, Unwritten). Works fully offline. One Pro key unlocks all five.

---

## What it measures

| | |
|---|---|
| **Active editing time** | Not "time with the file open". A burst of keystrokes ends after 60 seconds of silence, and the silence is **never counted** — the note is credited with the span of the keystrokes themselves. Leaving a note open on a second monitor for eight hours earns it nothing. |
| **Revision sessions** | Editing bursts more than 30 minutes apart are separate revisions. "Rewritten five times" is a different fact from "typed for two hours once". |
| **Dwell time** | Wall-clock time the note was the note you were looking at — paused the moment the window loses focus. |
| **Coldness** | Days since you last opened it. |

## The read surface

**Show expensive notes** (command, or the sidebar view): *the most expensive notes you have not opened in 90 days*, ranked by measured editing time. That list is the plugin. Everything above exists to make it honest.

Also: **Show effort for this note**, **Export effort data as CSV**, and **Clear the activity log**.

## Privacy — read this

This add-on records, **on your device only**, which notes you open and how long you spend editing them.

- The log lives in `<vault>/.obsidian/second-read/signals/`.
- **It never leaves your machine.** There is no network request, no account, no telemetry, and no phone-home — not for tracking, not for licensing.
- Delete the folder to erase it, or use **Clear the activity log** in settings.
- If you sync your `.obsidian` folder, the log syncs with it, and "when did I open this note" becomes cross-device history. If you do not want that, exclude the folder from your sync tool.

The log is shared with **Note Decay** (it needs *last opened*; we need *editing time*; both come from the same events). Exactly one Second Read add-on writes to it at a time — the others read. Installing Effort Index a year after Note Decay means it starts with a year of history instead of nothing.

## Settings

Idle cutoff (60 s), minimum session (5 s), revision gap (30 min), dwell cap (30 min), cold after (90 days), retention (730 days), excluded folders, and the activity-log controls.

## Pro

Free covers everything above, on desktop and mobile. **Second Read Pro — $29 one-time**, one key for all five add-ons:

- **Orphaned investment** — expensive notes whose ideas were never reused anywhere else in the vault.
- **Topic-grouped effort reports.**

Both compare notes by *meaning*, which needs a local semantic engine (a program that runs on your computer, downloaded only when you explicitly ask for it, and which opens no network connections). Desktop only. Everything else works everywhere.

## Install

Not yet in the community directory. To install manually, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/effort-index/`.

## Development

```bash
npm install
npm run lint      # tsc + the review bot's own eslint ruleset, zero warnings
npm test          # lint + vendored-core drift check + the test suite
npm run build     # production bundle
VAULT=/path/to/vault npm run install:vault
```

`src/shared/` is **vendored** from [`obsidian-plugin-core`](https://github.com/israerusan/obsidian-plugin-core) — never edit it here. Run `npm run sync:shared` to pull; `npm test` fails on drift.

## License

MIT. See [LICENSE](LICENSE).
