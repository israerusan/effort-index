/**
 * Orphaned-investment ranking (DESIGN 8.3).
 *
 * The threshold is the easy half. The half that matters is what happens to a note the engine
 * did NOT answer for: a missing probe is not a similarity of zero, and a plugin that treats it
 * as one accuses the user's whole vault of being wasted work the moment the engine hiccups.
 */
import assert from "node:assert";
import {
	DEFAULT_ORPHAN_MAX_SCORE,
	describeOrphan,
	isProbed,
	selectOrphans,
} from "../src/core/orphaned.mjs";

const row = (path, editMs, extra = {}) => ({
	path,
	editMs,
	editSessions: 1,
	revisions: 1,
	dwellMs: 0,
	lastOpen: 0,
	lastEdit: 0,
	firstSeen: 0,
	daysSinceOpen: 10,
	...extra,
});

// --- the threshold ---------------------------------------------------------------------
{
	assert.equal(DEFAULT_ORPHAN_MAX_SCORE, 0.45, "DESIGN 6.5 pins the orphan bar at 0.45");

	const rows = [row("A.md", 5000), row("B.md", 4000), row("C.md", 3000)];
	const probes = {
		"A.md": { bestScore: 0.12, bestNote: "" }, // nothing like it anywhere
		"B.md": { bestScore: 0.9, bestNote: "Dup.md" }, // reused, heavily
		"C.md": { bestScore: 0.45, bestNote: "Edge.md" }, // exactly AT the bar
	};

	const result = selectOrphans(rows, probes);
	assert.deepEqual(
		result.rows.map((r) => r.path),
		["A.md"],
		"only the note below the bar is orphaned — the bar itself is NOT below the bar"
	);
	assert.equal(result.analysed, 3);
	assert.equal(result.skipped, 0);
	assert.equal(result.candidates, 3);
}

// --- AN UNPROBED NOTE IS NEVER AN ORPHAN ------------------------------------------------
// The load-bearing one. The engine died halfway through the scan; the notes it never reached
// must be reported as un-analysed, not as "nobody ever reused this".
{
	const rows = [row("Scanned.md", 9000), row("EngineDied.md", 8000), row("AlsoDied.md", 7000)];
	const probes = { "Scanned.md": { bestScore: 0.1 } };

	const result = selectOrphans(rows, probes);
	assert.deepEqual(
		result.rows.map((r) => r.path),
		["Scanned.md"],
		"a note the engine never answered for must NOT be accused of being orphaned"
	);
	assert.equal(result.analysed, 1, "one note was actually looked at");
	assert.equal(result.skipped, 2, "and two were not — the caller must be able to say so");
	assert.equal(result.candidates, 3);
}

// --- a probe with a junk score is "unknown", not "isolated" -------------------------------
{
	const rows = [row("NaN.md", 100), row("Missing.md", 100), row("Negative.md", 100), row("Text.md", 100)];
	const probes = {
		"NaN.md": { bestScore: Number.NaN },
		"Missing.md": {},
		"Negative.md": { bestScore: -1 },
		"Text.md": { bestScore: "0.1" },
	};
	const result = selectOrphans(rows, probes);
	assert.equal(result.rows.length, 0, "no orphan may be inferred from a score we cannot trust");
	assert.equal(result.analysed, 0);
	assert.equal(result.skipped, 4);

	assert.equal(isProbed({ bestScore: 0 }), true, "a real zero IS an answer: nothing resembles it");
	assert.equal(isProbed({ bestScore: 1 }), true);
	assert.equal(isProbed({ bestScore: 1.5 }), false, "a cosine cannot exceed 1");
	assert.equal(isProbed(undefined), false);
	assert.equal(isProbed(null), false);
}

// --- a genuine zero IS a finding ----------------------------------------------------------
{
	const result = selectOrphans([row("Alone.md", 1000)], { "Alone.md": { bestScore: 0, bestNote: "" } });
	assert.equal(result.rows.length, 1, "the engine answered, and the answer was 'nothing'");
	assert.equal(result.analysed, 1);
	assert.equal(result.skipped, 0);
	assert.match(describeOrphan(result.rows[0]), /Nothing else in the vault resembles it/);
}

// --- ordering is by cost, then isolation, then path (stable across runs) --------------------
{
	const rows = [
		row("Cheap.md", 1000),
		row("Expensive.md", 9000),
		row("TieB.md", 5000),
		row("TieA.md", 5000),
	];
	const probes = {
		"Cheap.md": { bestScore: 0.01 },
		"Expensive.md": { bestScore: 0.4 },
		"TieA.md": { bestScore: 0.3 },
		"TieB.md": { bestScore: 0.1 },
	};
	const result = selectOrphans(rows, probes);
	assert.deepEqual(
		result.rows.map((r) => r.path),
		["Expensive.md", "TieB.md", "TieA.md", "Cheap.md"],
		"most expensive first; equal cost breaks on the MORE isolated note"
	);

	// Same input, same order — a report that reshuffles between runs looks broken even when right.
	const again = selectOrphans(rows, probes);
	assert.deepEqual(again.rows.map((r) => r.path), result.rows.map((r) => r.path));
}

// --- a raised bar catches more; a limit truncates ------------------------------------------
{
	const rows = [row("A.md", 3000), row("B.md", 2000), row("C.md", 1000)];
	const probes = { "A.md": { bestScore: 0.6 }, "B.md": { bestScore: 0.5 }, "C.md": { bestScore: 0.7 } };

	assert.equal(selectOrphans(rows, probes).rows.length, 0, "at the default bar, all three were reused");
	assert.deepEqual(
		selectOrphans(rows, probes, { orphanMaxScore: 0.65 }).rows.map((r) => r.path),
		["A.md", "B.md"],
		"raising the bar admits weaker reuse as 'orphaned'"
	);
	assert.deepEqual(
		selectOrphans(rows, probes, { orphanMaxScore: 0.65, limit: 1 }).rows.map((r) => r.path),
		["A.md"]
	);
}

// --- the closest-note sentence ---------------------------------------------------------------
{
	const [orphan] = selectOrphans([row("A.md", 1)], {
		"A.md": { bestScore: 0.31, bestNote: "Decisions/Storage.md" },
	}).rows;
	assert.equal(describeOrphan(orphan), "Closest note: Decisions/Storage.md — similarity 0.31.");
	assert.equal(describeOrphan({ path: "x" }), "Not analysed.");
}

// --- degenerate input does not throw ----------------------------------------------------------
{
	assert.equal(selectOrphans(null, null).rows.length, 0);
	assert.equal(selectOrphans([], {}).candidates, 0);
	assert.equal(selectOrphans([row("A.md", 1)], undefined).skipped, 1);
}

console.log("ok  orphaned.test.mjs");
