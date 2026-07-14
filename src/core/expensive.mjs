/**
 * The read surface — PURE. "The most expensive notes you have not opened in N days."
 *
 * Input is a `SignalsIndex` folded from the SHARED signals log (the same log Note Decay
 * writes to), so this ranks by real, measured, idle-trimmed editing time rather than by
 * file size or word count. No `obsidian` import, no clock: `now` is a parameter.
 *
 * THE SELECTION RULE, in order:
 *   1. The note must still exist (`livePaths`, when the caller can enumerate the vault).
 *   2. The note must be under none of `excludeFolders`.
 *   3. The note must have absorbed real work — `editMs > 0`. A note you only ever read is
 *      not "expensive", however long you stared at it.
 *   4. The note must be COLD: `now − lastOpen > staleDays`. A note never opened while we
 *      were watching has `lastOpen === 0`; measuring its coldness from the epoch would put
 *      every such note at the top forever, so we measure from `firstSeen` — the first
 *      moment the log saw it at all — which is the same fallback Note Decay uses.
 *
 * Ranked by `editMs` desc, ties broken by `revisions` desc, then by path asc so the order
 * is stable across runs (a view that reshuffles identical rows on every refresh looks broken).
 */

export const DEFAULT_STALE_DAYS = 90;
export const DAY_MS = 24 * 60 * 60 * 1000;

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function num(value) {
	return isFiniteNumber(value) && value >= 0 ? value : 0;
}

/** Normalise a user-typed folder into a `foo/bar/` prefix. Blank entries are dropped. */
export function normalizeFolder(folder) {
	const trimmed = String(folder ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed === "" ? "" : `${trimmed}/`;
}

/** True when `path` sits inside one of `folders`. Prefix match on a normalised folder, so
 *  "Archive" excludes "Archive/2024/x.md" but never "Archived Ideas.md". */
export function isExcluded(path, folders) {
	if (!Array.isArray(folders) || folders.length === 0) return false;
	const target = String(path ?? "");
	for (const folder of folders) {
		const prefix = normalizeFolder(folder);
		if (prefix !== "" && target.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * The moment we last had any evidence the user looked at this note. `lastOpen` when we ever
 * saw an open; otherwise `firstSeen` — see the header. 0 means "no evidence at all", and the
 * caller treats that as infinitely cold.
 */
export function lastSeenAt(signals) {
	const lastOpen = num(signals?.lastOpen);
	if (lastOpen > 0) return lastOpen;
	return num(signals?.firstSeen);
}

/** Whole days since we last saw the note opened. `Infinity` when there is no evidence. */
export function daysSinceOpen(signals, now) {
	const seen = lastSeenAt(signals);
	if (seen <= 0) return Infinity;
	if (now <= seen) return 0;
	return Math.floor((now - seen) / DAY_MS);
}

/**
 * @param {Record<string, object>} index  folded signals, keyed by note path
 * @param {object} opts
 * @returns {object[]} rows, richest first
 */
export function selectExpensiveNotes(index, opts = {}) {
	const now = isFiniteNumber(opts.now) ? opts.now : 0;
	// A NEGATIVE staleDays is legal and means "no coldness filter at all" (`daysSinceOpen` is
	// never negative, so every note passes). That is how the CSV export gets every note
	// without a second, near-identical selector that could drift from this one.
	const staleDays = isFiniteNumber(opts.staleDays) ? opts.staleDays : DEFAULT_STALE_DAYS;
	const excludeFolders = Array.isArray(opts.excludeFolders) ? opts.excludeFolders : [];
	const livePaths = opts.livePaths instanceof Set ? opts.livePaths : null;
	const limit = isFiniteNumber(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;

	const rows = [];
	for (const [path, signals] of Object.entries(index || {})) {
		if (!signals || typeof signals !== "object") continue;
		if (livePaths && !livePaths.has(path)) continue;
		if (isExcluded(path, excludeFolders)) continue;

		const editMs = num(signals.editMs);
		if (editMs <= 0) continue;

		const cold = daysSinceOpen(signals, now);
		if (!(cold > staleDays)) continue;

		rows.push({
			path,
			editMs,
			editSessions: num(signals.editSessions),
			revisions: num(signals.revisions),
			dwellMs: num(signals.dwellMs),
			lastOpen: num(signals.lastOpen),
			lastEdit: num(signals.lastEdit),
			firstSeen: num(signals.firstSeen),
			daysSinceOpen: cold,
		});
	}

	rows.sort((a, b) => {
		if (b.editMs !== a.editMs) return b.editMs - a.editMs;
		if (b.revisions !== a.revisions) return b.revisions - a.revisions;
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});

	return limit === Infinity ? rows : rows.slice(0, limit);
}

/** "2h 14m" / "47m" / "38s" / "—". Never "0h 0m": a zero reads as a bug, not a number. */
export function formatDuration(ms) {
	const total = Math.max(0, Math.floor(num(ms) / 1000));
	if (total === 0) return "—";
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/** "12 days ago" / "Never opened". */
export function formatColdness(days) {
	if (!isFiniteNumber(days)) return "Never opened";
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	return `${days} days ago`;
}

/**
 * Excel, LibreOffice, Sheets and Numbers all treat a cell that STARTS with `= + - @` (or a
 * leading tab/CR, which they strip before looking) as a formula, not as text. A note called
 * `=cmd|'/c calc'!A1.md` is a legal filename, and exporting it unescaped hands the user's
 * spreadsheet a live formula the moment they double-click the CSV — the classic CSV-injection
 * shape, in a file the user believes is a list of their own note names.
 *
 * The fix is the OWASP one: prefix the cell with an apostrophe, which every one of those
 * programs reads as "the rest of this is literally text", and then quote it so the apostrophe
 * survives as data rather than being eaten by the delimiter rules.
 */
function csvCell(value) {
	const text = String(value ?? "");
	const dangerous = /^[=+\-@\t\r]/.test(text);
	const body = dangerous ? `'${text}` : text;
	return dangerous || /[",\n]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

/** RFC-4180-ish CSV of the selected rows. Pure, so the export is testable without a vault. */
export function toCsv(rows) {
	const header = ["path", "editMs", "editSessions", "revisions", "dwellMs", "lastOpen", "lastEdit", "daysSinceOpen"];
	const lines = [header.join(",")];
	for (const row of rows || []) {
		lines.push(
			[
				csvCell(row.path),
				row.editMs,
				row.editSessions,
				row.revisions,
				row.dwellMs,
				row.lastOpen,
				row.lastEdit,
				Number.isFinite(row.daysSinceOpen) ? row.daysSinceOpen : "",
			].join(",")
		);
	}
	return lines.join("\n") + "\n";
}
