/**
 * Topic-clustered effort reporting — PURE (DESIGN 4.4, 8.3).
 *
 * "Group the effort report by topic": the same expensive notes, collected into the subjects
 * they actually belong to, so the answer to *where did the time go?* is "eleven hours on
 * storage" rather than forty file names.
 *
 * The engine supplies EDGES — for each expensive note, its nearest neighbours among the other
 * expensive notes, with a cosine score. This file turns those edges into groups, and it does it
 * with STAR clustering rather than connected components, on purpose:
 *
 *   Connected components chain. With a threshold anywhere near where real notes actually sit
 *   (0.55–0.65), A~B and B~C drags A and C into one "topic" even when A and C have nothing to
 *   do with each other, and one long chain of weak links eventually swallows the whole vault
 *   into a single cluster called "everything". A star has a centre: every member is within the
 *   threshold OF THE SEED, so the group means something you can name.
 *
 * The seed is the most expensive unassigned note, which makes the clusters read the way the
 * user thinks — the group forms around the note they sank the most time into, and it is named
 * after it. Everything about the traversal is deterministic (seed order is editMs desc, then
 * path asc; members likewise), because a report that reshuffles between two identical runs
 * looks broken even when it is right.
 *
 * A note with no neighbour above the bar is NOT a failure and is NOT dropped: it goes to
 * `ungrouped`, which the view renders as "on its own" — visible, honest, and often the most
 * interesting row on the page.
 */

/**
 * MiniLM: unrelated English ≈ 0.05–0.25, related ≈ 0.40–0.60, near-duplicate ≥ 0.75 (DESIGN 6.5).
 * 0.60 is deliberately at the top of "related": a topic group that merely shares a vocabulary is
 * noise, and the cost of being too strict is a note in `ungrouped`, which is a fine place to be.
 */
export const DEFAULT_CLUSTER_MIN_SCORE = 0.6;

/** A "cluster" of one is a note on its own. It belongs in `ungrouped`, not in a group of one. */
export const MIN_CLUSTER_SIZE = 2;

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

/** `Projects/Storage engine.md` -> `Storage engine`. The cluster's name is its seed's title. */
export function noteTitle(path) {
	const text = String(path ?? "");
	const name = text.slice(text.lastIndexOf("/") + 1);
	return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/**
 * Fold directed engine hits into an undirected adjacency of the STRONGEST score seen between
 * each pair. The engine is asked "what is near A?" and separately "what is near B?", and the
 * two answers do not have to agree — cosine is symmetric but top-k is not, so B can appear in
 * A's list while A falls off the end of B's. Taking the max of whatever we saw means one
 * direction is enough to make the link.
 */
export function buildAdjacency(edges, minScore) {
	const bar = isFiniteNumber(minScore) ? minScore : DEFAULT_CLUSTER_MIN_SCORE;
	const adjacency = new Map();
	const link = (from, to, score) => {
		if (!adjacency.has(from)) adjacency.set(from, new Map());
		const row = adjacency.get(from);
		const prior = row.get(to);
		if (prior === undefined || score > prior) row.set(to, score);
	};

	for (const edge of Array.isArray(edges) ? edges : []) {
		if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") continue;
		if (edge.from === edge.to) continue; // a note is not its own neighbour
		if (!isFiniteNumber(edge.score) || edge.score < bar) continue;
		link(edge.from, edge.to, edge.score);
		link(edge.to, edge.from, edge.score);
	}
	return adjacency;
}

/**
 * @param {Array<object>} rows expensive rows (from `selectExpensiveNotes`)
 * @param {Array<{from: string, to: string, score: number}>} edges engine hits between those rows
 * @param {{minScore?: number, limit?: number}} [opts]
 * @returns {{clusters: object[], ungrouped: object[], grouped: number}}
 */
export function clusterByTopic(rows, edges, opts = {}) {
	const minScore = isFiniteNumber(opts.minScore) ? opts.minScore : DEFAULT_CLUSTER_MIN_SCORE;
	const source = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row.path === "string");
	const byPath = new Map(source.map((row) => [row.path, row]));
	const adjacency = buildAdjacency(edges, minScore);

	// Deterministic seed order: the note that cost the most goes first, ties by path.
	const order = [...source].sort((a, b) => {
		const aMs = isFiniteNumber(a.editMs) ? a.editMs : 0;
		const bMs = isFiniteNumber(b.editMs) ? b.editMs : 0;
		if (bMs !== aMs) return bMs - aMs;
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});

	const assigned = new Set();
	const clusters = [];
	const ungrouped = [];

	for (const seed of order) {
		if (assigned.has(seed.path)) continue;

		const neighbours = [...(adjacency.get(seed.path) ?? new Map()).entries()]
			.filter(([path]) => byPath.has(path) && !assigned.has(path) && path !== seed.path)
			.sort((a, b) => {
				if (b[1] !== a[1]) return b[1] - a[1]; // strongest link first
				return a[0] < b[0] ? -1 : 1;
			});

		if (neighbours.length + 1 < MIN_CLUSTER_SIZE) {
			assigned.add(seed.path);
			ungrouped.push(seed);
			continue;
		}

		const members = [
			{ ...seed, score: 1, seed: true },
			...neighbours.map(([path, score]) => ({ ...byPath.get(path), score, seed: false })),
		];
		for (const member of members) assigned.add(member.path);

		// Members read in the order the user cares about — cost, not similarity.
		members.sort((a, b) => {
			const aMs = isFiniteNumber(a.editMs) ? a.editMs : 0;
			const bMs = isFiniteNumber(b.editMs) ? b.editMs : 0;
			if (bMs !== aMs) return bMs - aMs;
			return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
		});

		clusters.push({
			id: seed.path,
			label: noteTitle(seed.path),
			seed: seed.path,
			notes: members,
			size: members.length,
			editMs: members.reduce((sum, row) => sum + (isFiniteNumber(row.editMs) ? row.editMs : 0), 0),
		});
	}

	// The most expensive TOPIC first: that is the whole point of grouping by it.
	clusters.sort((a, b) => {
		if (b.editMs !== a.editMs) return b.editMs - a.editMs;
		if (b.size !== a.size) return b.size - a.size;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	const limit = isFiniteNumber(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
	const grouped = clusters.reduce((sum, cluster) => sum + cluster.size, 0);
	return {
		clusters: limit === Infinity ? clusters : clusters.slice(0, limit),
		ungrouped,
		grouped,
	};
}
