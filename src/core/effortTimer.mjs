/**
 * The editing timer — PURE. No `obsidian` import, no Node builtin, no I/O, and above all
 * NO CLOCK: every transition is a function of `(state, event)` where the event carries its
 * own timestamp. That is what makes the one piece of logic this plugin lives or dies on
 * testable with plain asserts and no fake timers.
 *
 * WHAT IT IS FOR. "How much work went into this note" is worthless if leaving a file open
 * counts as work. A note left on screen over a lunch break would out-score a note somebody
 * actually rewrote, and the whole "most expensive notes" view would rank by nothing but
 * neglect. So:
 *
 *   THE IDLE BOUNDARY (the load-bearing rule)
 *   An editing burst is a run of keystrokes. It CLOSES after `idleCutoffMs` of silence,
 *   and the milliseconds it contributes are `lastKeystroke − burstStart` — the span of the
 *   keystrokes themselves. The trailing silence that closed it is NOT work and is never
 *   counted, and a keystroke arriving after the gap starts a NEW burst rather than
 *   extending the old one. Editing seconds can therefore never accrue across an idle gap.
 *
 * Two independent paths close a burst, and BOTH are needed:
 *   - `tick` (the dead-man check, driven by a 5 s interval): closes a burst while the user
 *     is idle but still has the file open.
 *   - `key` (a keystroke whose gap from the previous one is >= idleCutoffMs): closes the
 *     old burst and opens a new one. This is the path that survives a laptop suspend, a
 *     throttled background timer, or any other reason the ticks did not arrive — without
 *     it, sleeping for eight hours and typing one character would bank eight hours.
 *
 * DWELL is tracked separately: wall-clock time the note was the active one, paused while
 * the window has no focus (`blur`) and resumed on `focus`, and capped per event so that
 * "I left this open for three days" contributes at most `dwellCapMs`.
 *
 * Emits ready-to-append `SignalEvent`s (DESIGN 5.3) — the caller records them into the
 * SHARED signals store, where Note Decay reads the same log.
 */

/** Silence after which an editing burst is closed. DESIGN 5.3 default. */
export const DEFAULT_IDLE_CUTOFF_MS = 60_000;
/** Bursts shorter than this are noise (a stray keystroke in a note opened by mistake). */
export const DEFAULT_MIN_SESSION_MS = 5_000;
/** A single dwell event can never contribute more than this (you walked away). */
export const DEFAULT_DWELL_CAP_MS = 1_800_000;
/**
 * Dwell shorter than this is not emitted at all. Tabbing through ten notes to find one
 * would otherwise append ten near-zero events to a log that is shared, append-only, and
 * compacted on a line count.
 */
export const MIN_DWELL_MS = 1_000;

/**
 * "Nothing here" is `-1`, not `0`.
 *
 * `0` is a perfectly legal timestamp (the epoch) and, more to the point, it is the timestamp
 * every test writes first. A `0` sentinel would make the first keystroke of a burst read as
 * "no burst open", silently restart it on the second keystroke, and quietly under-count the
 * work — a bug that only ever shows up where the clock starts at zero. It does not get to
 * exist.
 */
export const NONE = -1;

/** A fresh timer: nothing focused, no burst open, no dwell running. */
export function initialState() {
	return {
		path: null,
		/** First keystroke of the open burst; NONE when no burst is open. */
		start: NONE,
		/** Most recent keystroke of the open burst; NONE when no burst is open. */
		last: NONE,
		keys: 0,
		/** When the current (unpaused) dwell run began; NONE when dwell is paused or absent. */
		dwellStart: NONE,
		/** Dwell already banked for `path` across earlier focus runs. */
		dwellMs: 0,
	};
}

function clone(state) {
	return {
		path: state.path,
		start: state.start,
		last: state.last,
		keys: state.keys,
		dwellStart: state.dwellStart,
		dwellMs: state.dwellMs,
	};
}

function resolve(opts) {
	const idleCutoffMs = positive(opts?.idleCutoffMs, DEFAULT_IDLE_CUTOFF_MS);
	const minSessionMs = nonNegative(opts?.minSessionMs, DEFAULT_MIN_SESSION_MS);
	const dwellCapMs = positive(opts?.dwellCapMs, DEFAULT_DWELL_CAP_MS);
	return { idleCutoffMs, minSessionMs, dwellCapMs };
}

function positive(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Close the open burst, if any, and push its `edit` event.
 *
 * `ms` is `last − start`: the span of the keystrokes. Not `now − start`, which would bill
 * the user for the silence that closed the burst. A burst of a single keystroke has a span
 * of 0 and is dropped by `minSessionMs` — as is any burst below the threshold.
 *
 * `at` is only the timestamp the event is STAMPED with (so the log stays ordered); it never
 * contributes to `ms`.
 */
function closeBurst(state, at, opts, emit) {
	if (state.path === null || state.start < 0) {
		state.start = NONE;
		state.last = NONE;
		state.keys = 0;
		return;
	}
	const ms = Math.max(0, state.last - state.start);
	if (ms >= opts.minSessionMs) {
		emit.push({
			t: Math.max(at, state.last),
			k: "edit",
			p: state.path,
			ms,
			keys: state.keys,
		});
	}
	state.start = NONE;
	state.last = NONE;
	state.keys = 0;
}

/** Bank the running dwell segment (if any) into `dwellMs`, without emitting. */
function pauseDwell(state, at) {
	if (state.dwellStart < 0) return;
	const run = at - state.dwellStart;
	if (run > 0) state.dwellMs += run;
	state.dwellStart = NONE;
}

/** Close dwell for the current path and push a `dwell` event if it is worth a line. */
function closeDwell(state, at, opts, emit) {
	pauseDwell(state, at);
	const ms = Math.min(state.dwellMs, opts.dwellCapMs);
	if (state.path !== null && ms >= MIN_DWELL_MS) {
		emit.push({ t: at, k: "dwell", p: state.path, ms });
	}
	state.dwellMs = 0;
	state.dwellStart = NONE;
}

/** Close everything open on the current note: the burst first, then dwell. */
function closeNote(state, at, opts, emit) {
	closeBurst(state, at, opts, emit);
	closeDwell(state, at, opts, emit);
	state.path = null;
}

/**
 * Advance the timer by one event.
 *
 * @param {import("./effortTimer.d.mts").TimerState} state  never mutated — a new state is returned
 * @param {import("./effortTimer.d.mts").TimerEvent} e
 * @param {import("./effortTimer.d.mts").TimerOptions} [opts]
 * @returns {{ state: import("./effortTimer.d.mts").TimerState,
 *             emit: import("./effortTimer.d.mts").EmittedEvent[] }}
 */
export function step(state, e, opts = {}) {
	const resolved = resolve(opts);
	const next = clone(state ?? initialState());
	const emit = [];
	if (!e || typeof e !== "object" || typeof e.t !== "number" || !Number.isFinite(e.t)) {
		return { state: next, emit };
	}

	switch (e.k) {
		case "focus": {
			if (typeof e.path !== "string" || e.path === "") return { state: next, emit };
			if (next.path === e.path) {
				// Same note re-focused (window regained focus, or a duplicate leaf event).
				// Resume dwell if it was paused; never restart the burst.
				if (next.dwellStart < 0) next.dwellStart = e.t;
				return { state: next, emit };
			}
			closeNote(next, e.t, resolved, emit);
			next.path = e.path;
			next.dwellStart = e.t;
			next.dwellMs = 0;
			return { state: next, emit };
		}

		case "key": {
			if (typeof e.path !== "string" || e.path === "") return { state: next, emit };
			if (next.path !== e.path) {
				// A keystroke in a note we were not tracking (a split pane, or a `file-open` we
				// never saw). Treat it as focus + key rather than dropping the work.
				closeNote(next, e.t, resolved, emit);
				next.path = e.path;
				next.dwellStart = e.t;
				next.dwellMs = 0;
			}
			if (next.start < 0) {
				next.start = e.t;
				next.last = e.t;
				next.keys = 1;
				return { state: next, emit };
			}
			// THE IDLE BOUNDARY. A keystroke that arrives after the cutoff does not extend the
			// burst — it closes it (billing only the keystroke span that preceded the gap) and
			// opens a new one. Without this, a suspended laptop or a throttled `tick` timer
			// would let one keystroke bank the entire gap.
			if (e.t - next.last >= resolved.idleCutoffMs) {
				closeBurst(next, e.t, resolved, emit);
				next.start = e.t;
				next.last = e.t;
				next.keys = 1;
				return { state: next, emit };
			}
			if (e.t > next.last) next.last = e.t;
			next.keys += 1;
			return { state: next, emit };
		}

		case "tick": {
			// The dead-man check. The note is still open, the user has simply stopped typing.
			// Close the burst; dwell keeps running (they are still looking at it).
			if (next.start >= 0 && e.t - next.last >= resolved.idleCutoffMs) {
				closeBurst(next, e.t, resolved, emit);
			}
			return { state: next, emit };
		}

		case "blur": {
			// Window lost focus: dwell stops accruing. The burst is deliberately left OPEN —
			// a 5-second alt-tab in the middle of a sentence is not the end of an editing
			// session, and if the user never comes back the next `tick` closes it on the idle
			// rule anyway, billing only up to the last keystroke.
			pauseDwell(next, e.t);
			return { state: next, emit };
		}

		case "close": {
			closeNote(next, e.t, resolved, emit);
			return { state: next, emit };
		}

		default:
			return { state: next, emit };
	}
}

/** Apply a vault rename to an in-flight session, so the open burst is not orphaned. */
export function renamePath(state, from, to) {
	const next = clone(state ?? initialState());
	if (next.path === from) next.path = to;
	return next;
}

/** Drop an in-flight session for a note that has just been deleted. */
export function forgetPath(state, path) {
	const next = clone(state ?? initialState());
	if (next.path !== path) return next;
	return initialState();
}
