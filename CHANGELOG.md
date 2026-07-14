# Changelog

All notable changes to Effort Index are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-14

First release. The free tier is complete: everything below works offline, on desktop and mobile, with no account and no network request. The Pro tier is complete too — it is not sold yet, and the add-on says so rather than showing a button.

### Added

- **Active-editing measurement.** A keystroke-driven dead-man timer per note. An editing burst closes after 60 seconds of silence and is credited with the span of its keystrokes — the idle tail is never counted, so a note left open on screen earns nothing.
- **Revision sessions.** Bursts more than 30 minutes apart count as separate revisions.
- **Dwell time**, paused whenever the window loses focus and capped per visit.
- **Expensive-notes view** — the most expensive notes you have not opened in 90 days, ranked by measured editing time.
- **Show effort for this note**, **Export effort data as CSV**, and **Clear the activity log**.
- **Shared activity log** with the rest of the Second Read suite, under `<vault>/.obsidian/second-read/signals/`. A single-writer election means exactly one add-on appends, so nothing is ever double-counted — and installing this add-on after Note Decay inherits its history.

### Added — Pro

- **Orphaned-investment detection** (Pro). Every expensive note's own text is queried against the rest of the vault; those whose closest counterpart scores below 0.45 are reported as work that never propagated. A note the engine could not answer for is reported as *un-analysed* — never as orphaned.
- **Topic-grouped effort reporting** (Pro). The expensive-notes list, star-clustered around its costliest notes, so the report reads as subjects rather than filenames.
- **The semantic engine.** Both Pro features go through the shared, refcounted `EngineBroker`: five Second Read add-ons share ONE engine process and ONE index, and this add-on spawns nothing of its own. Nothing is downloaded without an explicit click in a consent modal that first names the URL, version, SHA-256 and install path; the checksum is verified before anything is run; superseded scans are cancelled at the engine.
- **Honest degradation.** Free tier, mobile, no engine installed, engine crashed and "genuinely nothing found" are five different outcomes, and the panel says which one it is. A Pro feature in this add-on cannot render an empty list that means anything other than "we looked, and there is nothing".
- **Second Read Pro licensing.** One offline-verified key unlocks Pro in all five add-ons. **There is no checkout yet**, so the Pro card names the features and states plainly that purchasing is not open — it does not render a purchase button. A pre-release build shipped a live "$29 — Unlock Pro" link to a generic tip-jar page, for features that did not exist and an `isPro` flag that gated nothing; both halves of that are fixed here, and both are covered by regression tests.

[1.0.0]: https://github.com/israerusan/effort-index/releases/tag/1.0.0
