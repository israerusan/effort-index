// The read surface's selector: "the most expensive notes you have not opened in N days".
import assert from "node:assert";
import {
	daysSinceOpen,
	formatColdness,
	formatDuration,
	isExcluded,
	selectExpensiveNotes,
	toCsv,
} from "../src/core/expensive.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

function note(overrides) {
	return {
		firstSeen: NOW - 400 * DAY,
		lastOpen: 0,
		opens: 0,
		editMs: 0,
		editSessions: 0,
		revisions: 0,
		lastEdit: 0,
		dwellMs: 0,
		...overrides,
	};
}

// --- ranked by editMs, ties broken by revisions, then path ---------------------------------
{
	const index = {
		"b.md": note({ editMs: 100, revisions: 1, lastOpen: NOW - 200 * DAY }),
		"a.md": note({ editMs: 100, revisions: 1, lastOpen: NOW - 200 * DAY }),
		"rich.md": note({ editMs: 500, revisions: 1, lastOpen: NOW - 200 * DAY }),
		"tied.md": note({ editMs: 100, revisions: 9, lastOpen: NOW - 200 * DAY }),
	};
	const rows = selectExpensiveNotes(index, { now: NOW, staleDays: 90 });
	assert.deepEqual(
		rows.map((row) => row.path),
		["rich.md", "tied.md", "a.md", "b.md"],
		"editMs desc, then revisions desc, then path asc (a stable order — the view must not reshuffle)"
	);
}

// --- staleDays is respected -----------------------------------------------------------------
{
	const index = {
		"cold.md": note({ editMs: 100, lastOpen: NOW - 120 * DAY }),
		"warm.md": note({ editMs: 100, lastOpen: NOW - 10 * DAY }),
		"edge.md": note({ editMs: 100, lastOpen: NOW - 90 * DAY }), // exactly 90 days: NOT yet cold
	};
	const rows = selectExpensiveNotes(index, { now: NOW, staleDays: 90 });
	assert.deepEqual(rows.map((row) => row.path), ["cold.md"], "only notes cold for MORE than staleDays");
}

// A note never opened while we were watching is measured from `firstSeen`, not from the epoch —
// otherwise every such note would sit at the top of the list forever.
{
	const index = {
		"never-old.md": note({ editMs: 100, lastOpen: 0, firstSeen: NOW - 200 * DAY }),
		"never-new.md": note({ editMs: 100, lastOpen: 0, firstSeen: NOW - 5 * DAY }),
	};
	const rows = selectExpensiveNotes(index, { now: NOW, staleDays: 90 });
	assert.deepEqual(
		rows.map((row) => row.path),
		["never-old.md"],
		"a note first seen 5 days ago is not '1000 days cold' just because we never logged an open"
	);
}

// --- a note with no measured editing is not "expensive", however long you stared at it -------
{
	const index = {
		"read-only.md": note({ editMs: 0, dwellMs: 9 * 3600 * 1000, lastOpen: NOW - 200 * DAY }),
		"worked.md": note({ editMs: 1, lastOpen: NOW - 200 * DAY }),
	};
	const rows = selectExpensiveNotes(index, { now: NOW, staleDays: 90 });
	assert.deepEqual(rows.map((row) => row.path), ["worked.md"]);
}

// --- excluded folders ------------------------------------------------------------------------
{
	const index = {
		"Archive/old.md": note({ editMs: 900, lastOpen: NOW - 200 * DAY }),
		"Archived Ideas.md": note({ editMs: 800, lastOpen: NOW - 200 * DAY }),
		"Notes/keep.md": note({ editMs: 700, lastOpen: NOW - 200 * DAY }),
	};
	const rows = selectExpensiveNotes(index, {
		now: NOW,
		staleDays: 90,
		excludeFolders: ["Archive", "  ", "Templates/"],
	});
	assert.deepEqual(
		rows.map((row) => row.path),
		["Archived Ideas.md", "Notes/keep.md"],
		"'Archive' excludes the FOLDER, not every path that starts with those letters"
	);

	assert.equal(isExcluded("Archive/x.md", ["Archive"]), true);
	assert.equal(isExcluded("Archived Ideas.md", ["Archive"]), false);
	assert.equal(isExcluded("x.md", []), false);
}

// --- livePaths drops ghost rows ---------------------------------------------------------------
{
	const index = {
		"gone.md": note({ editMs: 900, lastOpen: NOW - 200 * DAY }),
		"here.md": note({ editMs: 100, lastOpen: NOW - 200 * DAY }),
	};
	const rows = selectExpensiveNotes(index, {
		now: NOW,
		staleDays: 90,
		livePaths: new Set(["here.md"]),
	});
	assert.deepEqual(rows.map((row) => row.path), ["here.md"]);
}

// --- a negative staleDays disables the coldness filter (this is what the CSV export uses) ------
{
	const index = { "fresh.md": note({ editMs: 100, lastOpen: NOW }) };
	assert.equal(selectExpensiveNotes(index, { now: NOW, staleDays: 90 }).length, 0);
	assert.equal(selectExpensiveNotes(index, { now: NOW, staleDays: -1 }).length, 1, "export sees everything");
}

// --- limit -------------------------------------------------------------------------------------
{
	const index = {
		"a.md": note({ editMs: 300, lastOpen: NOW - 200 * DAY }),
		"b.md": note({ editMs: 200, lastOpen: NOW - 200 * DAY }),
		"c.md": note({ editMs: 100, lastOpen: NOW - 200 * DAY }),
	};
	assert.deepEqual(
		selectExpensiveNotes(index, { now: NOW, staleDays: 90, limit: 2 }).map((row) => row.path),
		["a.md", "b.md"]
	);
}

// --- coldness ----------------------------------------------------------------------------------
assert.equal(daysSinceOpen(note({ lastOpen: NOW - 3 * DAY }), NOW), 3);
assert.equal(daysSinceOpen(note({ lastOpen: NOW + DAY }), NOW), 0, "a clock skew is 0 days, never negative");
assert.equal(daysSinceOpen(note({ lastOpen: 0, firstSeen: 0 }), NOW), Infinity, "no evidence at all");
assert.equal(formatColdness(Infinity), "Never opened");
assert.equal(formatColdness(0), "Today");
assert.equal(formatColdness(1), "Yesterday");
assert.equal(formatColdness(12), "12 days ago");

// --- durations ----------------------------------------------------------------------------------
assert.equal(formatDuration(0), "—", "zero reads as a bug when rendered '0h 0m'");
assert.equal(formatDuration(38_000), "38s");
assert.equal(formatDuration(47 * 60_000), "47m");
assert.equal(formatDuration(2 * 3600_000 + 14 * 60_000), "2h 14m");

// --- CSV -----------------------------------------------------------------------------------------
{
	const rows = selectExpensiveNotes(
		{ 'Weird, "quoted".md': note({ editMs: 60_000, revisions: 2, lastOpen: NOW - 200 * DAY }) },
		{ now: NOW, staleDays: 90 }
	);
	const csv = toCsv(rows);
	const lines = csv.trim().split("\n");
	assert.equal(lines[0], "path,editMs,editSessions,revisions,dwellMs,lastOpen,lastEdit,daysSinceOpen");
	assert.ok(lines[1].startsWith('"Weird, ""quoted"".md",60000'), "commas and quotes are escaped");
	assert.ok(csv.endsWith("\n"));
}

// --- CSV injection --------------------------------------------------------------------------------
// A note path is a FILENAME, and every one of these is a legal one. Excel, LibreOffice, Sheets
// and Numbers evaluate a cell that starts with = + - @ (or a leading tab/CR, which they strip
// first) as a FORMULA — so an unescaped export hands the user's spreadsheet a live command the
// moment they double-click the file they just exported from their own note titles.
{
	const dangerous = [
		`=cmd|'/c calc'!A1.md`,
		`+1+1.md`,
		`-2+3.md`,
		`@SUM(A1).md`,
		`\tleading-tab.md`,
		`\rleading-cr.md`,
	];
	const index = {};
	for (const path of dangerous) index[path] = note({ editMs: 60_000, lastOpen: NOW - 200 * DAY });

	const rows = selectExpensiveNotes(index, { now: NOW, staleDays: 90 });
	assert.equal(rows.length, dangerous.length, "all of them are legal note paths and all are exported");

	const lines = toCsv(rows).trim().split("\n").slice(1);
	assert.equal(lines.length, dangerous.length);
	for (const line of lines) {
		assert.ok(
			line.startsWith(`"'`),
			`a formula cell must be neutralised with a leading apostrophe, got: ${line}`
		);
		assert.ok(
			!/^[=+\-@\t\r]/.test(line),
			`the cell must not begin with a formula trigger, got: ${line}`
		);
	}
	// The path is still READABLE — the apostrophe is the escape, not a mangling of the data.
	assert.ok(lines.some((line) => line.includes(`=cmd|'/c calc'!A1.md`)), "the real path survives verbatim");

	// ...and an ordinary path is left completely alone.
	const plain = toCsv(selectExpensiveNotes({ "Projects/Roadmap.md": note({ editMs: 60_000, lastOpen: NOW - 200 * DAY }) }, { now: NOW, staleDays: 90 }));
	assert.ok(plain.split("\n")[1].startsWith("Projects/Roadmap.md,60000"), "a normal path is not quoted or prefixed");
}

console.log("ok  expensive-query.test.mjs");
