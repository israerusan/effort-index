/** Hand-written types for expensive.mjs. Drift between the two is caught by `tsc --noEmit`. */

import type { NoteSignals, SignalsIndex } from "../shared/signals/signalsAggregate.d.mts";

export const DEFAULT_STALE_DAYS: number;
export const DAY_MS: number;

export interface ExpensiveRow {
	path: string;
	editMs: number;
	editSessions: number;
	revisions: number;
	dwellMs: number;
	lastOpen: number;
	lastEdit: number;
	firstSeen: number;
	/** `Infinity` when the log has no evidence the note was ever opened. */
	daysSinceOpen: number;
}

export interface ExpensiveOptions {
	now: number;
	staleDays?: number;
	excludeFolders?: readonly string[];
	/** When given, notes outside it are dropped (they no longer exist in the vault). */
	livePaths?: Set<string> | null;
	limit?: number;
}

export function normalizeFolder(folder: string): string;
export function isExcluded(path: string, folders: readonly string[] | undefined): boolean;
export function lastSeenAt(signals: NoteSignals | null | undefined): number;
export function daysSinceOpen(signals: NoteSignals | null | undefined, now: number): number;
export function selectExpensiveNotes(index: SignalsIndex, opts: ExpensiveOptions): ExpensiveRow[];
export function formatDuration(ms: number): string;
export function formatColdness(days: number): string;
export function toCsv(rows: readonly ExpensiveRow[]): string;
