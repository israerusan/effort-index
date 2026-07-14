// THE LOAD-BEARING TEST.
//
// Effort Index's entire claim is "this note absorbed two hours of real work". If idle time
// with a file open counted, the claim would be a lie and the expensive-notes list would rank
// notes by neglect. So: editing seconds must NEVER accrue across an idle gap. Every path
// that could let them is asserted below.
import assert from "node:assert";
import {
	DEFAULT_IDLE_CUTOFF_MS,
	MIN_DWELL_MS,
	NONE,
	forgetPath,
	initialState,
	renamePath,
	step,
} from "../src/core/effortTimer.mjs";
import { foldSignals } from "../src/shared/signals/signalsAggregate.mjs";

const OPTS = { idleCutoffMs: 60_000, minSessionMs: 5_000, dwellCapMs: 1_800_000 };
const NOTE = "Projects/Roadmap.md";
const S = 1000;

/** Drive a script of events through the timer, collecting everything it emits. */
function run(events, opts = OPTS, from = initialState()) {
	let state = from;
	const emitted = [];
	for (const event of events) {
		const result = step(state, event, opts);
		state = result.state;
		emitted.push(...result.emit);
	}
	return { state, emitted };
}

const edits = (emitted) => emitted.filter((e) => e.k === "edit");
const dwells = (emitted) => emitted.filter((e) => e.k === "dwell");

// --- 1. THE IDLE BOUNDARY, via the dead-man tick -------------------------------------------
//
// Keystrokes at 0s, 10s, 20s. Then 90 seconds of silence. The burst is worth 20 seconds —
// the span of the keystrokes — NOT the 110 seconds of wall clock that elapsed.
{
	const { emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 10 * S },
		{ k: "key", path: NOTE, t: 20 * S },
		{ k: "tick", t: 25 * S },   // still inside the cutoff — nothing closes
		{ k: "tick", t: 60 * S },   // 40s of silence — still inside the 60s cutoff
		{ k: "tick", t: 85 * S },   // 65s of silence — the burst closes HERE
		{ k: "tick", t: 110 * S },  // nothing left to close
	]);

	const written = edits(emitted);
	assert.equal(written.length, 1, "exactly one edit event for one burst");
	assert.equal(written[0].ms, 20 * S, "ms must be the keystroke span (20s), not the wall clock");
	assert.equal(written[0].p, NOTE);
	assert.equal(written[0].keys, 3);
	assert.ok(
		written[0].ms < 25 * S,
		"THE INVARIANT: the 65 seconds of idle that CLOSED the burst are not in it"
	);
}

// --- 2. THE IDLE BOUNDARY, via a keystroke after the gap ------------------------------------
//
// The tick is not enough on its own. A suspended laptop, a throttled background timer, or a
// missed interval means the ticks may simply not arrive. If the NEXT keystroke merely
// extended the open burst, sleeping for eight hours and typing one character would bank eight
// hours of "editing". It must close the old burst and open a new one.
{
	const { emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 10 * S },
		// ...the machine sleeps. No ticks fire. Eight hours later, one keystroke:
		{ k: "key", path: NOTE, t: 8 * 3600 * S },
		{ k: "key", path: NOTE, t: 8 * 3600 * S + 6 * S },
		{ k: "close", t: 8 * 3600 * S + 10 * S },
	]);

	const written = edits(emitted);
	assert.equal(written.length, 2, "the gap must SPLIT the work into two bursts, not one");
	assert.equal(written[0].ms, 10 * S, "the first burst is worth its own 10 seconds");
	assert.equal(written[1].ms, 6 * S, "the second burst is worth its own 6 seconds");

	const total = written.reduce((sum, e) => sum + e.ms, 0);
	assert.equal(total, 16 * S, "16 seconds of work, not 8 hours");
	assert.ok(total < 8 * 3600 * S, "THE INVARIANT: editing seconds did not accrue across the gap");
}

// --- 3. ...and the fold agrees ---------------------------------------------------------------
//
// The emitter trims the idle tail; the fold does not trust the emitter and clamps too. Both
// layers must agree, or the number in the view is not the number in the test.
{
	const { emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 10 * S },
		{ k: "key", path: NOTE, t: 20 * S },
		{ k: "tick", t: 85 * S },
		{ k: "key", path: NOTE, t: 200 * S },
		{ k: "key", path: NOTE, t: 205 * S },
		{ k: "close", t: 300 * S },
	]);

	const index = foldSignals(emitted, null, { minSessionMs: 5_000, revisionGapMs: 1_800_000 });
	assert.equal(index[NOTE].editMs, 25 * S, "20s + 5s of keystroke spans — and nothing else");
	assert.equal(index[NOTE].editSessions, 2);
	assert.ok(
		index[NOTE].editMs < 300 * S,
		"THE INVARIANT, end to end: 5 minutes of wall clock became 25 seconds of work"
	);
}

// --- 4. A burst below minSessionMs is discarded ---------------------------------------------
{
	const { emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 2 * S }, // a 2-second burst: noise
		{ k: "tick", t: 70 * S },
		{ k: "close", t: 80 * S },
	]);
	assert.equal(edits(emitted).length, 0, "a 2s burst is below the 5s floor and is dropped");
}

// A single keystroke has a span of ZERO and must never be recorded as a session.
{
	const { emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 1000 },
		{ k: "close", t: 5000 },
	]);
	assert.equal(edits(emitted).length, 0, "one keystroke is a zero-length span, not a session");
}

// --- 5. Switching files closes the open session ---------------------------------------------
{
	const OTHER = "Inbox/Scratch.md";
	const { state, emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 30 * S },
		{ k: "focus", path: OTHER, t: 40 * S }, // switch away mid-burst
	]);

	const written = edits(emitted);
	assert.equal(written.length, 1, "the burst is flushed on the file switch, not lost");
	assert.equal(written[0].p, NOTE, "and it is credited to the note that was edited");
	assert.equal(written[0].ms, 30 * S, "still the keystroke span — the 10s before the switch is not work");
	assert.equal(state.path, OTHER);
	assert.equal(state.start, NONE, "the new note starts with no burst open");

	const dwell = dwells(emitted);
	assert.equal(dwell.length, 1, "leaving the note also closes its dwell");
	assert.equal(dwell[0].p, NOTE);
	assert.equal(dwell[0].ms, 40 * S);
}

// --- 6. `close` at unload flushes ------------------------------------------------------------
{
	const { state, emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 12 * S },
		{ k: "close", t: 15 * S }, // Obsidian quits mid-burst
	]);
	const written = edits(emitted);
	assert.equal(written.length, 1, "a burst in progress at unload is real work and must be flushed");
	assert.equal(written[0].ms, 12 * S);
	assert.equal(state.path, null, "and the timer is reset");
	assert.equal(dwells(emitted).length, 1);
}

// --- 7. blur pauses dwell; focus resumes it ---------------------------------------------------
{
	const { emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "blur", t: 10 * S },            // walked away at 10s
		{ k: "focus", path: NOTE, t: 610 * S }, // came back 10 minutes later
		{ k: "close", t: 620 * S },
	]);
	const dwell = dwells(emitted);
	assert.equal(dwell.length, 1);
	assert.equal(dwell[0].ms, 20 * S, "10s before the blur + 10s after the focus — not the 10 idle minutes");
}

// Dwell is capped per visit: leaving Obsidian open on one note all day banks the cap, not the day.
{
	const { emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "close", t: 24 * 3600 * S },
	]);
	assert.equal(dwells(emitted)[0].ms, OPTS.dwellCapMs, "a 24-hour visit contributes the 30-minute cap");
}

// A drive-by focus that lasts under a second is not worth a line in an append-only log.
{
	const { emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "focus", path: "Other.md", t: 200 },
	]);
	assert.equal(dwells(emitted).length, 0, `dwell below ${MIN_DWELL_MS}ms is not emitted`);
}

// --- 8. blur does NOT kill an editing burst ---------------------------------------------------
//
// Alt-tabbing to check a reference for five seconds is not the end of an editing session. The
// idle rule still governs: if they never come back, the next tick closes the burst and bills
// only up to the last keystroke.
{
	const { emitted } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 0 },
		{ k: "blur", t: 5 * S },
		{ k: "focus", path: NOTE, t: 12 * S },
		{ k: "key", path: NOTE, t: 15 * S }, // same burst — the gap never reached the cutoff
		{ k: "close", t: 20 * S },
	]);
	const written = edits(emitted);
	assert.equal(written.length, 1, "a short alt-tab does not split the burst");
	assert.equal(written[0].ms, 15 * S);
}

// --- 9. a keystroke in an untracked note is adopted, not dropped -------------------------------
{
	const { state, emitted } = run([{ k: "key", path: NOTE, t: 0 }, { k: "key", path: NOTE, t: 9 * S }, { k: "close", t: 10 * S }]);
	assert.equal(state.path, null);
	assert.equal(edits(emitted)[0]?.ms, 9 * S, "work in a note we never saw focused still counts");
}

// --- 10. rename follows the in-flight session; delete drops it ----------------------------------
{
	const MOVED = "Archive/Roadmap.md";
	let { state } = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 8 * S },
	]);
	state = renamePath(state, NOTE, MOVED);
	const after = step(state, { k: "close", t: 10 * S }, OPTS);
	assert.equal(edits(after.emit)[0].p, MOVED, "the open burst follows the note to its new path");

	let dropped = run([
		{ k: "focus", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 0 },
		{ k: "key", path: NOTE, t: 8 * S },
	]).state;
	dropped = forgetPath(dropped, NOTE);
	const afterDelete = step(dropped, { k: "close", t: 10 * S }, OPTS);
	assert.equal(afterDelete.emit.length, 0, "a deleted note's in-flight session is dropped, not resurrected");
}

// --- 11. the shipped default is the documented one ----------------------------------------------
assert.equal(DEFAULT_IDLE_CUTOFF_MS, 60_000, "DESIGN 5.3: the idle cutoff default is 60s");

console.log("ok  effort-timer.test.mjs");
