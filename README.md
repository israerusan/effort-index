# Effort Index

**Measure the editing time and revision effort behind every note, then resurface the expensive ones you stopped reading.**

Your vault does not tell you what anything cost. A note you rewrote seven times over three months looks exactly like a note you pasted in and never touched again. Effort Index measures the difference — and then shows you the notes you paid the most for and have not opened since.

<!-- SCREENSHOT SLOT — drop a real Obsidian capture here to lift conversions.
     ![The "expensive notes you haven't opened in 90 days" panel, ranked by measured editing time](docs/assets/hero.png)
     Suggested shot: the expensive-notes sidebar panel ranked by editing time, plus the per-note effort readout. Save as docs/assets/hero.png -->


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

Pro adds: the orphan threshold (0.45), the topic threshold (0.60), how many notes a semantic scan looks at (40), and the semantic-engine controls.

## Pro

Free covers everything above, on desktop and mobile, with no engine and no network. **Second Read Pro — $29 one-time**, one key for all five add-ons:

- **Orphaned investment** — the expensive notes whose ideas were never reused anywhere else in your vault. Each note's own text is compared against the rest of the vault; a note whose closest counterpart scores below 0.45 is one where the hours went in and nothing came out. Open the **Orphaned** tab in the expensive-notes panel, or run **Find expensive notes nobody reused**.
- **Topic-grouped effort reports** — the same expensive-notes list, collected into the subjects it actually belongs to, so "where did the time go?" answers *eleven hours on storage* rather than forty file names. The **By topic** tab, or **Group the effort report by topic**.

Both compare notes by *meaning*, so both need the local semantic engine described below. Desktop only. If you have no engine installed, both say so plainly and offer to install one — neither ever returns an empty list you could mistake for "nothing found".

> **Second Read Pro — $29 one-time.** One key unlocks Pro in all five Second Read add-ons (Note Decay, Standing Questions, Effort Index, Prior Art, Unwritten). Buy here: https://buymeacoffee.com/vaultspotlight/e/560213 — the key is emailed to you **automatically, within seconds** (delivery is fully automated) and pasted into settings; it is verified offline.

## The semantic engine (Pro, desktop only)

The Pro features need a local embedding engine. This is the part to read carefully, because it is the part that runs a program on your computer.

- **Nothing is downloaded until you click.** The engine is fetched only from the settings tab (or the install offer in the panel), and only after a modal has shown you the exact URL, the version, the SHA-256, and the directory it will be written to.
- **The checksum is verified before anything is run.** On a mismatch the file is deleted and nothing is extracted, made executable, or spawned. The installed binary is re-checked against that digest on *every* start.
- **It is installed outside your vault** — `%LOCALAPPDATA%\second-read-engine` on Windows, `~/Library/Application Support/second-read-engine` on macOS, `${XDG_DATA_HOME:-~/.local/share}/second-read-engine` on Linux. This add-on therefore reads and writes files outside your vault, and this line is that disclosure. It stays out of `.obsidian/` on purpose: so your sync tool does not replicate 100 MB of binary to your phone.
- **It opens no network connections.** It speaks JSON over stdin/stdout to Obsidian and nothing else — no port, no listener, no server. It exits when Obsidian does.
- **It never updates itself.** When a newer version exists you are shown an **Update engine** button. Nothing happens until you press it.
- **One engine, five add-ons.** All the Second Read add-ons share a single engine process and a single index; installing a second one does not spawn a second engine.
- **You can bring your own.** Set *Path to an existing engine* in settings and nothing is ever downloaded — the escape hatch for antivirus quarantine, `noexec` mounts and Flatpak confinement.

Source for the engine: [`github.com/israerusan/second-read-engine`](https://github.com/israerusan/second-read-engine).

## Install

**Community plugins (recommended):** open **Settings → Community plugins**, search **Effort Index**, and install it — one click, auto-updates.

**Manual install:** copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/effort-index/`.

## Feedback and support

Bug reports, feature requests, and questions all go to the GitHub issue tracker. It is
the only place I track them, so an issue will always get further than a review comment.

- **[Report a bug](https://github.com/israerusan/effort-index/issues/new?labels=bug)** — please include your Obsidian version, your operating system, and the steps that reproduce it.
- **[Request a feature](https://github.com/israerusan/effort-index/issues/new?labels=enhancement)** — describe the workflow you are trying to make faster; that is more useful than a proposed solution.
- **[Browse open issues](https://github.com/israerusan/effort-index/issues)** — worth a look first, in case it is already tracked.

## More plugins by the same author

Small, local-first Obsidian plugins that each do one job and keep your data in your vault.
All of them are in the community directory — search the name under
**Settings → Community plugins**.

**Search and views**

- [Vault Spotlight](https://github.com/israerusan/obsidian-vault-spotlight) — keyboard-first command center — fuzzy search, saved workflows, and result actions.
- [Bases Power Pack](https://github.com/israerusan/bases-power-pack) — kanban, calendar, Gantt, and outline views over your notes or a `.base` file.

**Vault health**

- [Vault Triage](https://github.com/israerusan/vault-triage) — find stale, orphaned, unfinished, and metadata-broken notes, then work through them.
- [Attachment Audit](https://github.com/israerusan/attachment-audit) — find orphaned, duplicate, oversized, and misplaced attachments, then clean them up safely.
- [Patina](https://github.com/israerusan/patina) — score every note's staleness from edits, opens, and inbound links.
- [Vault Router](https://github.com/israerusan/vault-router) — move new notes out of Inbox with fast local routing rules.
- [FlowKit Health Dashboard](https://github.com/israerusan/flowkit-health-dashboard) — find which add-on is breaking your vault, and score every one installed.

**Writing and research**

- [Prose Lens](https://github.com/israerusan/prose-lens) — live writing feedback — passive voice, adverbs, hedges, cliches, and a reading grade.
- [Prior Art](https://github.com/israerusan/prior-art) — show similar existing notes while you write, and merge duplicates without losing links.
- [Standing Questions](https://github.com/israerusan/standing-questions) — track the open questions in your vault and surface new notes that may answer them.
- [Unwritten](https://github.com/israerusan/unwritten) — report the notes you never wrote — unexplained link pairs, stub hubs, unreasoned decisions.

**Time and billing**

- [Task Calendar Bridge](https://github.com/israerusan/obsidian-task-calendar-bridge) — export dated Markdown tasks to standards-based ICS calendar files.
- [Invoice Forge](https://github.com/israerusan/obsidian-invoice-forge) — turn `#billable` notes into numbered invoices, so nothing is missed or billed twice.
- [Time Tracker and Invoicing](https://github.com/israerusan/time-tracker-invoicing) — track billable time against notes and projects, then invoice by client.

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
