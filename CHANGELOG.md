# Changelog

All notable changes to Effort Index are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-14

First release. The free tier is complete: everything below works offline, on desktop and mobile, with no account and no network request.

### Added

- **Active-editing measurement.** A keystroke-driven dead-man timer per note. An editing burst closes after 60 seconds of silence and is credited with the span of its keystrokes — the idle tail is never counted, so a note left open on screen earns nothing.
- **Revision sessions.** Bursts more than 30 minutes apart count as separate revisions.
- **Dwell time**, paused whenever the window loses focus and capped per visit.
- **Expensive-notes view** — the most expensive notes you have not opened in 90 days, ranked by measured editing time.
- **Show effort for this note**, **Export effort data as CSV**, and **Clear the activity log**.
- **Shared activity log** with the rest of the Second Read suite, under `<vault>/.obsidian/second-read/signals/`. A single-writer election means exactly one add-on appends, so nothing is ever double-counted — and installing this add-on after Note Decay inherits its history.
- **Second Read Pro licensing.** One offline-verified key unlocks Pro in all five add-ons.

[1.0.0]: https://github.com/israerusan/effort-index/releases/tag/1.0.0
