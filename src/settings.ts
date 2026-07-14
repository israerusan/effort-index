import {
	DEFAULT_DWELL_CAP_MS,
	DEFAULT_IDLE_CUTOFF_MS,
	DEFAULT_MIN_SESSION_MS,
} from "./core/effortTimer.mjs";
import { DEFAULT_STALE_DAYS } from "./core/expensive.mjs";
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

	/**
	 * This plugin's shard id in the shared signals log. Generated once, then never changed —
	 * changing it orphans every event this install has ever written.
	 */
	signalsWriterId: string;

	schemaVersion: number;
}

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

	signalsWriterId: "",

	schemaVersion: 1,
};

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
