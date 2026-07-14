/** Orphaned-investment ranking (DESIGN 8.3). Pure — see orphaned.mjs. */

import type { ExpensiveRow } from "./expensive.d.mts";

export const DEFAULT_ORPHAN_MAX_SCORE: number;
export const ORPHAN_PROBE_K: number;

/** What the engine answered for one note: its closest non-self neighbour in the vault. */
export interface ReuseProbe {
	/** Cosine similarity, 0..1. Absent/NaN means the probe did not complete — NOT "zero". */
	bestScore?: number;
	bestNote?: string;
	bestPreview?: string;
	bestHeading?: string;
}

export interface OrphanRow extends ExpensiveRow {
	bestScore: number;
	bestNote: string;
	bestPreview: string;
	bestHeading: string;
}

export interface OrphanSelection {
	rows: OrphanRow[];
	/** Notes the engine actually answered for. */
	analysed: number;
	/** Notes it did not — never counted as orphans, and never hidden from the user. */
	skipped: number;
	/** Expensive notes offered to the selector in the first place. */
	candidates: number;
}

/** True when a probe carries a usable score. An unusable probe is "unknown", not "isolated". */
export function isProbed(probe: ReuseProbe | undefined | null): boolean;

export function selectOrphans(
	rows: ExpensiveRow[],
	probes: Record<string, ReuseProbe>,
	opts?: { orphanMaxScore?: number; limit?: number }
): OrphanSelection;

export function describeOrphan(row: OrphanRow): string;
