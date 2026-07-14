// Revision counting, over the SHARED fold (src/shared/signals/signalsAggregate.mjs — vendored,
// byte-identical to Note Decay's copy). "Rewritten five times over three months" is a
// different fact from "typed for two hours once", and this is where that distinction is made.
//
// A revision is an editing burst separated from the previous one by at least `revisionGapMs`.
//
// NOTE the epoch base. The shared validator rejects `t <= 0` outright — an event at the epoch
// is malformed, not "very old" — so a test that starts its clock at 0 silently folds NOTHING
// and asserts against an empty index. Every timestamp here is a real one.
import assert from "node:assert";
import { foldSignals, mergeSignals } from "../src/shared/signals/signalsAggregate.mjs";

const NOTE = "Projects/Roadmap.md";
const MINUTE = 60_000;
const T0 = 1_700_000_000_000;
const OPTS = { revisionGapMs: 30 * MINUTE, minSessionMs: 5_000, dwellCapMs: 30 * MINUTE };

const edit = (offset, ms) => ({ t: T0 + offset, k: "edit", p: NOTE, ms, keys: 10 });
const open = (offset) => ({ t: T0 + offset, k: "open", p: NOTE });

// --- bursts 20 minutes apart are ONE revision --------------------------------------------
{
	const index = foldSignals([edit(0, 10_000), edit(20 * MINUTE, 10_000)], null, OPTS);
	assert.equal(index[NOTE].editSessions, 2, "two bursts");
	assert.equal(index[NOTE].revisions, 1, "...but 20 minutes apart is one sitting, so one revision");
	assert.equal(index[NOTE].editMs, 20_000);
}

// --- bursts 40 minutes apart are TWO revisions -------------------------------------------
{
	const index = foldSignals([edit(0, 10_000), edit(40 * MINUTE, 10_000)], null, OPTS);
	assert.equal(index[NOTE].editSessions, 2);
	assert.equal(index[NOTE].revisions, 2, "40 minutes apart is coming back to it — two revisions");
}

// Exactly at the gap counts as a new revision (the boundary is inclusive, and it is asserted
// so nobody "cleans up" the >= into a > and silently changes everyone's numbers).
{
	const index = foldSignals([edit(0, 10_000), edit(30 * MINUTE, 10_000)], null, OPTS);
	assert.equal(index[NOTE].revisions, 2, "the revision gap boundary is inclusive");
}

// --- the fold does not trust the emitter --------------------------------------------------
//
// The timer trims the idle tail before it ever writes an `edit`. But a corrupted line, an old
// build, or a clock jump could still claim "9 hours of editing" in a burst that started 60
// seconds after the previous one ended. The fold clamps `ms` to the wall-clock window since
// the last burst, so editing time can never accrue across an idle gap even if the log lies.
{
	const index = foldSignals([edit(0, 10_000), edit(60_000, 9 * 3600 * 1000)], null, OPTS);
	assert.equal(
		index[NOTE].editMs,
		10_000 + 60_000,
		"a burst cannot bank more time than has passed since the previous one closed"
	);
}

// --- shards merge additively --------------------------------------------------------------
//
// Only one plugin holds the writer slot at a time, so shards are disjoint in time and their
// sums add. `lastOpen`/`lastEdit` take the max.
{
	const a = foldSignals([open(1_000), edit(20_000, 10_000)], null, OPTS);
	const b = foldSignals([open(100_000), edit(120_000, 10_000)], null, OPTS);
	const merged = mergeSignals([a, b]);
	assert.equal(merged[NOTE].editMs, 20_000, "editing time sums across shards");
	assert.equal(merged[NOTE].opens, 2);
	assert.equal(merged[NOTE].lastOpen, T0 + 100_000, "lastOpen takes the max, not the sum");
	assert.equal(merged[NOTE].firstSeen, T0 + 1_000, "firstSeen takes the min");
}

// --- a rename carries the effort with it; a delete drops it --------------------------------
{
	const moved = foldSignals(
		[edit(0, 10_000), { t: T0 + 1_000, k: "rename", p: "Archive/Roadmap.md", from: NOTE }],
		null,
		OPTS
	);
	assert.equal(moved[NOTE], undefined, "the old path is gone");
	assert.equal(moved["Archive/Roadmap.md"].editMs, 10_000, "and the hours moved with the note");

	const gone = foldSignals([edit(0, 10_000), { t: T0 + 1_000, k: "delete", p: NOTE }], null, OPTS);
	assert.equal(gone[NOTE], undefined, "a deleted note leaves no ghost row");
}

console.log("ok  effort-aggregate.test.mjs");
