/** Hand-written types for effortTimer.mjs. Drift between the two is caught by `tsc --noEmit`. */

import type { EditEvent, DwellEvent } from "../shared/signals/signalsAggregate.d.mts";

/** The "absent" sentinel for `start`/`last`/`dwellStart`. NOT zero — zero is a legal timestamp. */
export const NONE: number;

export const DEFAULT_IDLE_CUTOFF_MS: number;
export const DEFAULT_MIN_SESSION_MS: number;
export const DEFAULT_DWELL_CAP_MS: number;
export const MIN_DWELL_MS: number;

/** A keystroke (`editor-change`) in `path`. */
export interface KeyEvent {
	k: "key";
	path: string;
	t: number;
}
/** `path` became the active note (`file-open` / `active-leaf-change`), or the window
 *  regained focus while it was active. */
export interface FocusEvent {
	k: "focus";
	path: string;
	t: number;
}
/** The window lost focus. Dwell pauses; the editing burst is left open. */
export interface BlurEvent {
	k: "blur";
	t: number;
}
/** The dead-man check, on a fixed interval. Closes an idle burst. */
export interface TickEvent {
	k: "tick";
	t: number;
}
/** No note is active any more, or the plugin is unloading. Flushes everything. */
export interface CloseEvent {
	k: "close";
	t: number;
}

export type TimerEvent = KeyEvent | FocusEvent | BlurEvent | TickEvent | CloseEvent;

/** The only events the timer produces. Both are appendable to the shared signals log. */
export type EmittedEvent = EditEvent | DwellEvent;

export interface TimerState {
	path: string | null;
	/** First keystroke of the open burst, or NONE. */
	start: number;
	/** Most recent keystroke of the open burst, or NONE. */
	last: number;
	keys: number;
	/** Start of the running dwell segment, or NONE when paused/absent. */
	dwellStart: number;
	dwellMs: number;
}

export interface TimerOptions {
	idleCutoffMs?: number;
	minSessionMs?: number;
	dwellCapMs?: number;
}

export interface StepResult {
	state: TimerState;
	emit: EmittedEvent[];
}

export function initialState(): TimerState;
export function step(state: TimerState, e: TimerEvent, opts?: TimerOptions): StepResult;
export function renamePath(state: TimerState, from: string, to: string): TimerState;
export function forgetPath(state: TimerState, path: string): TimerState;
