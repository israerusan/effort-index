/**
 * Orphaned investment — PURE (DESIGN 4.4, 6.5, 8.3).
 *
 * "Expensive notes whose ideas were never reused anywhere else in the vault." The engine
 * answers one question per note — *what, in the rest of the vault, is the closest thing to
 * this note?* — and this file turns those answers into a ranked report.
 *
 * THE RULE THAT MATTERS MOST HERE IS NOT THE THRESHOLD. It is what happens to a note the
 * engine did not answer for. A probe can fail — the child died, the request was cancelled by
 * a superseding run, the note has no chunks. A missing answer is NOT a similarity of zero, and
 * treating it as one would silently promote every note we failed to look at into the report as
 * "nobody ever reused this". So an unprobed note is `skipped`, never `orphan`, and the caller
 * is handed the counts so the UI can say what it actually did:
 *
 *     "Analysed 34 expensive notes. 5 are orphaned." — a finding.
 *     "Analysed 0 expensive notes."                  — NOT "no findings".
 *
 * `bestScore` is the cosine similarity of this note's best-matching chunk against its best
 * non-self neighbour, so 0 means "the vault holds nothing like this" and 1 means "there is a
 * copy of it somewhere". Below `orphanMaxScore` (default 0.45 — the band where MiniLM stops
 * calling two English passages related at all) the work never propagated.
 */

/** DESIGN 6.5: Effort Index — orphaned investment, best non-self similarity below this. */
export const DEFAULT_ORPHAN_MAX_SCORE = 0.45;

/** The engine is queried per note; asking for more than a handful of neighbours buys nothing. */
export const ORPHAN_PROBE_K = 3;

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * A probe result is USABLE only when it carries a real, finite, in-range score. Anything else
 * (undefined, null, NaN, a string, a negative) means "we do not know", and not knowing must
 * never be rendered as a finding.
 */
export function isProbed(probe) {
	if (!probe || typeof probe !== "object") return false;
	const score = probe.bestScore;
	return isFiniteNumber(score) && score >= 0 && score <= 1;
}

/**
 * Rank the expensive notes nobody reused.
 *
 * @param {Array<object>} rows expensive rows (from `selectExpensiveNotes`), richest first
 * @param {Record<string, {bestScore?: number, bestNote?: string, bestPreview?: string, bestHeading?: string}>} probes
 *        keyed by note path. A path missing from here was NOT analysed.
 * @param {{orphanMaxScore?: number, limit?: number}} [opts]
 * @returns {{rows: object[], analysed: number, skipped: number, candidates: number}}
 */
export function selectOrphans(rows, probes, opts = {}) {
	const maxScore = isFiniteNumber(opts.orphanMaxScore) ? opts.orphanMaxScore : DEFAULT_ORPHAN_MAX_SCORE;
	const limit = isFiniteNumber(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
	const source = Array.isArray(rows) ? rows : [];
	const table = probes && typeof probes === "object" ? probes : {};

	const orphans = [];
	let analysed = 0;
	let skipped = 0;

	for (const row of source) {
		if (!row || typeof row.path !== "string") continue;
		const probe = Object.prototype.hasOwnProperty.call(table, row.path) ? table[row.path] : undefined;
		if (!isProbed(probe)) {
			skipped += 1;
			continue;
		}
		analysed += 1;
		if (probe.bestScore >= maxScore) continue;

		orphans.push({
			...row,
			bestScore: probe.bestScore,
			bestNote: typeof probe.bestNote === "string" ? probe.bestNote : "",
			bestPreview: typeof probe.bestPreview === "string" ? probe.bestPreview : "",
			bestHeading: typeof probe.bestHeading === "string" ? probe.bestHeading : "",
		});
	}

	// The most expensive orphan first — that is the one that cost the most and returned the
	// least. Ties break on the LOWER similarity (the more isolated note), then on path, so the
	// list is stable across runs: a report that reshuffles identical rows looks broken.
	orphans.sort((a, b) => {
		if (b.editMs !== a.editMs) return b.editMs - a.editMs;
		if (a.bestScore !== b.bestScore) return a.bestScore - b.bestScore;
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});

	return {
		rows: limit === Infinity ? orphans : orphans.slice(0, limit),
		analysed,
		skipped,
		candidates: source.length,
	};
}

/**
 * "Nothing in your vault comes close to it." / "The closest thing is Storage.md (0.31)."
 * One sentence per row, so the view never has to invent copy for a number.
 */
export function describeOrphan(row) {
	if (!row || !isFiniteNumber(row.bestScore)) return "Not analysed.";
	const score = row.bestScore.toFixed(2);
	if (!row.bestNote) return `Nothing else in the vault resembles it (best match ${score}).`;
	return `Closest note: ${row.bestNote} — similarity ${score}.`;
}
