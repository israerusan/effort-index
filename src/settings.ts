import {
	DEFAULT_DWELL_CAP_MS,
	DEFAULT_IDLE_CUTOFF_MS,
	DEFAULT_MIN_SESSION_MS,
} from "./core/effortTimer.mjs";
import { DEFAULT_STALE_DAYS } from "./core/expensive.mjs";
import { DEFAULT_ORPHAN_MAX_SCORE } from "./core/orphaned.mjs";
import { DEFAULT_CLUSTER_MIN_SCORE } from "./core/clusters.mjs";
import {
	DEFAULT_RETENTION_MS,
	DEFAULT_REVISION_GAP_MS,
} from "./shared/signals/signalsAggregate.mjs";

/**
 * The settings SHAPE and its defaults. Rendering lives in ui/SettingsTab.ts — keeping the
 * two apart means the timer, the view, and the tests can read the shape without dragging
 * every `obsidian` symbol the settings tab touches into the bundle with them.
 *
 * The four timing knobs are stored in the units a HUMAN thinks in (seconds, minutes, days)
 * and converted to ms at the single boundary below. Storing ms and rendering seconds is how
 * a settings tab ends up off by 1000x.
 */
export interface EffortIndexSettings {
	licenseKey: string;
	/** Cached entitlement, derived from licenseKey. Persisted so startup is instant. */
	isPro: boolean;
	licenseEmail: string;

	/** Silence after which an editing burst is closed. The idle tail is never counted. */
	idleCutoffSeconds: number;
	/** Bursts shorter than this are discarded as noise. */
	minSessionSeconds: number;
	/** A single dwell event can never contribute more than this. */
	dwellCapMinutes: number;
	/** Bursts closer together than this are one revision. */
	revisionGapMinutes: number;
	/** "Expensive notes not opened in N days." */
	staleDays: number;
	/** Aggregates untouched for longer than this are dropped at compaction. */
	retentionDays: number;
	/** Notes under these folders are neither tracked nor reported. */
	excludeFolders: string[];

	// --- Pro (semantic) --------------------------------------------------------------
	//
	// These three are inert for a free user. They are NOT the gate — `isPro` is, through
	// `featureGates.isFeatureEnabled` — they are just the knobs the gated features read.

	/**
	 * A note is orphaned investment when its best non-self similarity is BELOW this
	 * (DESIGN 6.5: 0.45 — the point where MiniLM stops calling two English passages related).
	 */
	orphanMaxScore: number;
	/** Two expensive notes join one topic at or above this. 0.60 is the top of "related". */
	clusterMinScore: number;
	/**
	 * How many of the most expensive notes a semantic scan looks at. Each one is a round trip
	 * to the engine, so this is the difference between a report and a coffee break — and the
	 * report says how many it analysed, so the number is never hidden from the user.
	 */
	scanLimit: number;

	/**
	 * Absolute path to an engine binary the user already has. When set, NOTHING is ever
	 * downloaded. This is the documented fallback for Defender quarantine, `noexec` mounts,
	 * Flatpak confinement and a hostile Gatekeeper — and it is the honest answer to a reviewer
	 * asking whether the download is the mechanism or a convenience.
	 */
	enginePath: string;

	/**
	 * This plugin's shard id in the shared signals log. Generated once, then never changed —
	 * changing it orphans every event this install has ever written.
	 */
	signalsWriterId: string;

	schemaVersion: number;
}

/**
 * The most expensive N notes a semantic scan looks at. One engine round trip each, so this is
 * the knob between "a report" and "a coffee break". Declared BEFORE DEFAULT_SETTINGS, which
 * reads it at module load — a `const` referenced before its declaration is a TDZ crash, not a
 * hoist.
 */
export const DEFAULT_SCAN_LIMIT = 40;
export const MIN_SCAN_LIMIT = 10;
export const MAX_SCAN_LIMIT = 200;

export const DEFAULT_SETTINGS: EffortIndexSettings = {
	licenseKey: "",
	isPro: false,
	licenseEmail: "",

	idleCutoffSeconds: DEFAULT_IDLE_CUTOFF_MS / 1000,
	minSessionSeconds: DEFAULT_MIN_SESSION_MS / 1000,
	dwellCapMinutes: DEFAULT_DWELL_CAP_MS / 60_000,
	revisionGapMinutes: DEFAULT_REVISION_GAP_MS / 60_000,
	staleDays: DEFAULT_STALE_DAYS,
	retentionDays: DEFAULT_RETENTION_MS / (24 * 60 * 60 * 1000),
	excludeFolders: [],

	orphanMaxScore: DEFAULT_ORPHAN_MAX_SCORE,
	clusterMinScore: DEFAULT_CLUSTER_MIN_SCORE,
	scanLimit: DEFAULT_SCAN_LIMIT,
	enginePath: "",

	signalsWriterId: "",

	schemaVersion: 1,
};

/**
 * `data.json` is a file on the user's disk. It is edited by hand, merged by Obsidian Sync,
 * truncated by a crash, and written by whatever the previous version of this plugin was. So
 * NOTHING in it is trusted to have the type the interface above promises.
 *
 * The rule this exists to enforce: `onload()` must never throw. A `licenseKey` that came back
 * as a number made `refreshLicense()` call `.trim()` on it and the whole plugin failed to load
 * with a stack trace — no view, no settings tab, no way for the user to fix the file that broke
 * it. Every field is coerced back to its declared type here, once, at the single boundary
 * where untrusted data enters.
 *
 * `__proto__` is deleted before the merge: a hostile data.json must not be able to forge
 * `isPro` onto every object in the runtime.
 */
export function coerceSettings(loaded: unknown): EffortIndexSettings {
	const data: Record<string, unknown> =
		loaded && typeof loaded === "object" && !Array.isArray(loaded)
			? { ...(loaded as Record<string, unknown>) }
			: {};
	if (Object.prototype.hasOwnProperty.call(data, "__proto__")) delete data["__proto__"];

	const merged = Object.assign({}, DEFAULT_SETTINGS, data) as Record<string, unknown>;

	return {
		licenseKey: coerceString(merged.licenseKey),
		isPro: merged.isPro === true,
		licenseEmail: coerceString(merged.licenseEmail),

		idleCutoffSeconds: coerceNumber(merged.idleCutoffSeconds, DEFAULT_SETTINGS.idleCutoffSeconds),
		minSessionSeconds: coerceNumber(merged.minSessionSeconds, DEFAULT_SETTINGS.minSessionSeconds),
		dwellCapMinutes: coerceNumber(merged.dwellCapMinutes, DEFAULT_SETTINGS.dwellCapMinutes),
		revisionGapMinutes: coerceNumber(merged.revisionGapMinutes, DEFAULT_SETTINGS.revisionGapMinutes),
		staleDays: coerceNumber(merged.staleDays, DEFAULT_SETTINGS.staleDays),
		retentionDays: coerceNumber(merged.retentionDays, DEFAULT_SETTINGS.retentionDays),
		excludeFolders: coerceStringArray(merged.excludeFolders),

		// A similarity is a cosine, so it is meaningless outside 0..1 — a hand-edited 40 (someone
		// thinking in percent) would make EVERY note orphaned, which is the worst false positive
		// this add-on can produce. Clamp rather than trust.
		orphanMaxScore: clamp(coerceNumber(merged.orphanMaxScore, DEFAULT_SETTINGS.orphanMaxScore), 0, 1),
		clusterMinScore: clamp(coerceNumber(merged.clusterMinScore, DEFAULT_SETTINGS.clusterMinScore), 0, 1),
		scanLimit: Math.round(
			clamp(coerceNumber(merged.scanLimit, DEFAULT_SETTINGS.scanLimit), MIN_SCAN_LIMIT, MAX_SCAN_LIMIT)
		),
		enginePath: coerceString(merged.enginePath).trim(),

		signalsWriterId: coerceString(merged.signalsWriterId),

		schemaVersion: coerceNumber(merged.schemaVersion, DEFAULT_SETTINGS.schemaVersion),
	};
}

/** A non-string (number, null, object) becomes "" — never `String(value)`, which would turn a
 *  corrupt `licenseKey: 42` into the key "42" and then report it as invalid rather than absent. */
function coerceString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** NaN and Infinity are not numbers a slider can render or a timer can wait for. */
function coerceNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function coerceStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export interface TimingOptions {
	idleCutoffMs: number;
	minSessionMs: number;
	dwellCapMs: number;
	revisionGapMs: number;
	retentionMs: number;
}

/** The ONE place human units become milliseconds. Every consumer reads this, nothing else
 *  multiplies by 1000. */
export function timingOptions(settings: EffortIndexSettings): TimingOptions {
	return {
		idleCutoffMs: Math.max(5, settings.idleCutoffSeconds) * 1000,
		minSessionMs: Math.max(0, settings.minSessionSeconds) * 1000,
		dwellCapMs: Math.max(1, settings.dwellCapMinutes) * 60_000,
		revisionGapMs: Math.max(1, settings.revisionGapMinutes) * 60_000,
		retentionMs: Math.max(1, settings.retentionDays) * 24 * 60 * 60 * 1000,
	};
}
