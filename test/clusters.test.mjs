/**
 * Topic-clustered effort reporting (DESIGN 8.3).
 *
 * The interesting property is the one the obvious implementation gets wrong: connected
 * components CHAIN. A~B and B~C drags A and C into one "topic" even when A and C are nothing
 * alike, and one long chain of weak links eventually swallows the vault into a single group
 * called "everything". Star clustering has a centre, so a group always means something.
 */
import assert from "node:assert";
import {
	DEFAULT_CLUSTER_MIN_SCORE,
	MIN_CLUSTER_SIZE,
	buildAdjacency,
	clusterByTopic,
	noteTitle,
} from "../src/core/clusters.mjs";

const row = (path, editMs) => ({
	path,
	editMs,
	editSessions: 1,
	revisions: 1,
	dwellMs: 0,
	lastOpen: 0,
	lastEdit: 0,
	firstSeen: 0,
	daysSinceOpen: 100,
});

// --- the shape of a cluster ------------------------------------------------------------
{
	assert.equal(DEFAULT_CLUSTER_MIN_SCORE, 0.6);
	assert.equal(MIN_CLUSTER_SIZE, 2);

	const rows = [row("Storage.md", 9000), row("Storage notes.md", 4000), row("Recipes.md", 3000)];
	const edges = [{ from: "Storage.md", to: "Storage notes.md", score: 0.81 }];

	const { clusters, ungrouped, grouped } = clusterByTopic(rows, edges);
	assert.equal(clusters.length, 1);
	assert.equal(clusters[0].label, "Storage", "a cluster is named after the note it formed around");
	assert.equal(clusters[0].seed, "Storage.md", "and it forms around the most EXPENSIVE note");
	assert.deepEqual(
		clusters[0].notes.map((n) => n.path),
		["Storage.md", "Storage notes.md"]
	);
	assert.equal(clusters[0].editMs, 13000, "the topic's cost is the sum of its notes'");
	assert.equal(clusters[0].size, 2);
	assert.equal(grouped, 2);

	assert.deepEqual(
		ungrouped.map((n) => n.path),
		["Recipes.md"],
		"a note with no neighbour is NOT dropped — it is on its own, and that is a finding"
	);
	assert.equal(clusters[0].notes[0].seed, true);
	assert.equal(clusters[0].notes[1].seed, false);
	assert.equal(clusters[0].notes[1].score, 0.81);
}

// --- THE ANTI-CHAINING PROPERTY -----------------------------------------------------------
// A~B (0.7) and B~C (0.7), but A and C have nothing to do with each other. Connected components
// would put all three in one "topic". A star centred on the most expensive note must not.
{
	const rows = [row("B.md", 9000), row("A.md", 5000), row("C.md", 4000)];
	const edges = [
		{ from: "A.md", to: "B.md", score: 0.7 },
		{ from: "B.md", to: "C.md", score: 0.7 },
		// deliberately NO A~C edge: they are not alike
	];

	const { clusters } = clusterByTopic(rows, edges);
	assert.equal(clusters.length, 1);
	assert.deepEqual(
		clusters[0].notes.map((n) => n.path).sort(),
		["A.md", "B.md", "C.md"],
		"B is the hub and both are within the bar OF B — that is a legitimate star"
	);

	// Now make A the hub instead, with C attached only to B. C must NOT be dragged in through B.
	const rows2 = [row("A.md", 9000), row("B.md", 5000), row("C.md", 4000)];
	const edges2 = [
		{ from: "A.md", to: "B.md", score: 0.7 },
		{ from: "B.md", to: "C.md", score: 0.7 },
	];
	const result2 = clusterByTopic(rows2, edges2);
	assert.equal(result2.clusters.length, 1);
	assert.deepEqual(
		result2.clusters[0].notes.map((n) => n.path),
		["A.md", "B.md"],
		"C is close to B but NOT to the seed — chaining it in would invent a topic"
	);
	assert.deepEqual(
		result2.ungrouped.map((n) => n.path),
		["C.md"],
		"and C ends up on its own rather than being silently swallowed"
	);
}

// --- the threshold is enforced --------------------------------------------------------------
{
	const rows = [row("A.md", 2000), row("B.md", 1000)];
	const weak = [{ from: "A.md", to: "B.md", score: 0.59 }];

	assert.equal(clusterByTopic(rows, weak).clusters.length, 0, "0.59 is below the 0.60 bar");
	assert.equal(clusterByTopic(rows, weak).ungrouped.length, 2);
	assert.equal(
		clusterByTopic(rows, weak, { minScore: 0.5 }).clusters.length,
		1,
		"lowering the bar groups them"
	);
	assert.equal(
		clusterByTopic(rows, [{ from: "A.md", to: "B.md", score: 0.6 }]).clusters.length,
		1,
		"AT the bar counts — the bar is a minimum, not an exclusive one"
	);
}

// --- one direction is enough to make a link ---------------------------------------------------
// Cosine is symmetric but top-k is not: B can show up in A's hit list while A falls off the end
// of B's. Taking the max of whatever we saw is what keeps that from losing the edge.
{
	const rows = [row("A.md", 2000), row("B.md", 1000)];
	const oneWay = [{ from: "A.md", to: "B.md", score: 0.7 }];
	assert.equal(clusterByTopic(rows, oneWay).clusters.length, 1);

	const adjacency = buildAdjacency(
		[
			{ from: "A.md", to: "B.md", score: 0.7 },
			{ from: "B.md", to: "A.md", score: 0.9 },
		],
		0.6
	);
	assert.equal(adjacency.get("A.md").get("B.md"), 0.9, "the STRONGEST score seen wins");
	assert.equal(adjacency.get("B.md").get("A.md"), 0.9);
}

// --- clusters are ordered by what the topic COST ------------------------------------------------
{
	const rows = [
		row("Big1.md", 6000),
		row("Big2.md", 5000),
		row("Small1.md", 4000),
		row("Small2.md", 1000),
	];
	const edges = [
		{ from: "Big1.md", to: "Big2.md", score: 0.8 },
		{ from: "Small1.md", to: "Small2.md", score: 0.8 },
	];
	const { clusters } = clusterByTopic(rows, edges);
	assert.deepEqual(
		clusters.map((c) => c.label),
		["Big1", "Small1"],
		"11000ms of storage outranks 5000ms of recipes"
	);
	assert.deepEqual(clusters.map((c) => c.editMs), [11000, 5000]);
}

// --- deterministic, and self-edges/strangers are ignored -------------------------------------
{
	const rows = [row("A.md", 5000), row("B.md", 5000), row("C.md", 5000)];
	const edges = [
		{ from: "A.md", to: "A.md", score: 1 }, // a note is not its own neighbour
		{ from: "A.md", to: "Ghost.md", score: 0.99 }, // not an expensive note; not in the report
		{ from: "A.md", to: "B.md", score: 0.7 },
		{ from: "A.md", to: "C.md", score: 0.7 },
	];
	const first = clusterByTopic(rows, edges);
	const second = clusterByTopic(rows, edges);
	assert.deepEqual(
		first.clusters[0].notes.map((n) => n.path),
		["A.md", "B.md", "C.md"],
		"all-equal cost falls back to path order, so the output never reshuffles"
	);
	assert.deepEqual(
		second.clusters[0].notes.map((n) => n.path),
		first.clusters[0].notes.map((n) => n.path)
	);
	assert.equal(first.clusters[0].size, 3, "Ghost.md is not in the effort report and must not be grouped into it");
}

// --- degenerate input ---------------------------------------------------------------------------
{
	assert.deepEqual(clusterByTopic([], []).clusters, []);
	assert.deepEqual(clusterByTopic(null, null).ungrouped, []);
	assert.equal(clusterByTopic([row("A.md", 1)], [{ from: "A.md", to: "B.md", score: Number.NaN }]).clusters.length, 0);
	assert.equal(noteTitle("Projects/Storage engine.md"), "Storage engine");
	assert.equal(noteTitle("Bare"), "Bare");
}

console.log("ok  clusters.test.mjs");
