// `activeWindow` is a GLOBAL that Obsidian declares (obsidian.d.ts `declare global`), not a
// module export — and it is the popout-safe one: `window` is the main window even when the
// user has dragged the note into a second OS window, so a listener on `window` would never
// fire for the window they are actually typing in.
import { MarkdownView, TFile } from "obsidian";
import type { Plugin, WorkspaceLeaf } from "obsidian";
import type { SignalStore } from "../shared/signals/SignalStore";
import type { SignalEvent } from "../shared/signals/signalsAggregate.d.mts";
import { forgetPath, initialState, renamePath, step } from "../core/effortTimer.mjs";
import type { TimerOptions, TimerState } from "../core/effortTimer.d.mts";
import { isExcluded } from "../core/expensive.mjs";

/**
 * The instrumentation. Everything Obsidian-shaped lives here; every RULE about what counts
 * as work lives in the pure `core/effortTimer.mjs`. This class is deliberately dumb: it
 * turns workspace events into timer events, hands the timer whatever it emits to the shared
 * store, and owns nothing else.
 *
 * WHY IT RECORDS INTO A SHARED LOG. Note Decay needs `lastOpen`; we need `editMs`. Both
 * derive from the same three events. If both plugins were loaded and both appended, every
 * event would be logged twice and the two would interleave partial writes into one file.
 * So every Second Read plugin attaches its OWN listeners and calls `record()` for every
 * event — and `record()` is a no-op unless this plugin currently holds the writer slot
 * (SignalsBroker). Exactly one copy of each event is ever appended. Do not "optimise" this
 * by skipping the listeners when we are not the writer: the election is lazy, and the
 * plugin that wins it is whoever records next.
 *
 * THE DEAD-MAN TICK is a 5 s interval, not a per-keystroke timeout. A `setTimeout` reset on
 * every `editor-change` would be a timer churn of one clear+set per character typed; the
 * tick costs one comparison every five seconds and closes the burst at the same boundary.
 */

/** How often the dead-man check runs. Well under the 60 s idle cutoff it enforces. */
export const TICK_MS = 5_000;

export interface TrackerHost {
	plugin: Plugin;
	store: SignalStore;
	/** Read fresh on every event — the user can change these mid-session. */
	timing(): TimerOptions;
	excludeFolders(): string[];
}

export class EffortTracker {
	private state: TimerState = initialState();
	private readonly host: TrackerHost;

	constructor(host: TrackerHost) {
		this.host = host;
	}

	/** Attach every listener. All of them go through `registerEvent`/`registerInterval`/
	 *  `registerDomEvent`, so unload tears them down and nothing leaks. */
	start(): void {
		const { plugin } = this.host;
		const { workspace, vault } = plugin.app;

		plugin.registerEvent(
			workspace.on("editor-change", (_editor, info) => {
				// `info` is a MarkdownView or a MarkdownFileInfo; both carry the file.
				const path = info.file?.path ?? null;
				if (path) this.dispatch({ k: "key", path, t: Date.now() });
			})
		);

		plugin.registerEvent(
			workspace.on("file-open", (file) => {
				const now = Date.now();
				if (!(file instanceof TFile) || file.extension !== "md" || this.excluded(file.path)) {
					// Whatever is now in front of the user is not a note we track — but the note we
					// WERE tracking has stopped being active, so its session must still be closed.
					this.dispatch({ k: "close", t: now });
					return;
				}
				this.record({ t: now, k: "open", p: file.path });
				this.dispatch({ k: "focus", path: file.path, t: now });
			})
		);

		// `file-open` does not fire when the user moves between two leaves that already hold
		// files. Without this, dwell would keep accruing against the note they navigated away
		// from — the exact "idle with a file open inflates the score" failure this plugin exists
		// to avoid.
		//
		// BUT: `active-leaf-change` also fires for every leaf that is NOT a note — the file
		// explorer, the search pane, the graph, and this plugin's OWN "expensive notes" panel.
		// Dispatching `close` for those (which is what an old build did, because
		// `getActiveViewOfType(MarkdownView)` returns null when a sidebar leaf is active) ENDED
		// the editing session: `closeBurst` discards any burst under `minSessionMs` outright, so
		// typing 4 s, clicking our own panel, and typing 4 s more recorded ZERO seconds instead
		// of eight. A sidebar click is not the end of a session. It is treated exactly like a
		// window `blur`: dwell pauses (they are looking at something else), the burst stays open,
		// and the dead-man `tick` still closes it on the idle rule if they never come back.
		plugin.registerEvent(
			workspace.on("active-leaf-change", (leaf) => {
				const now = Date.now();
				const note = leafNote(leaf);
				if (note === null) {
					this.dispatch({ k: "blur", t: now });
					return;
				}
				// A real note, but one we do not track (an excluded folder) — the session on the
				// PREVIOUS note is genuinely over, so close it.
				if (this.excluded(note.path)) this.dispatch({ k: "close", t: now });
				else this.dispatch({ k: "focus", path: note.path, t: now });
			})
		);

		plugin.registerEvent(
			vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				this.state = renamePath(this.state, oldPath, file.path);
				this.record({ t: Date.now(), k: "rename", p: file.path, from: oldPath });
			})
		);

		plugin.registerEvent(
			vault.on("delete", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				// Drop the in-flight session BEFORE the delete lands, or the flush at close would
				// resurrect an aggregate for a note that no longer exists.
				this.state = forgetPath(this.state, file.path);
				this.record({ t: Date.now(), k: "delete", p: file.path });
			})
		);

		plugin.registerInterval(
			window.setInterval(() => this.dispatch({ k: "tick", t: Date.now() }), TICK_MS)
		);

		// Dwell pauses when the window loses focus. Without this, walking away with Obsidian
		// open would bank hours of "time spent with this note".
		plugin.registerDomEvent(activeWindow, "blur", () => this.dispatch({ k: "blur", t: Date.now() }));
		plugin.registerDomEvent(activeWindow, "focus", () => {
			const path = this.activeNotePath();
			if (path) this.dispatch({ k: "focus", path, t: Date.now() });
		});

		// The note that is already open when we load never fires `file-open`.
		const initial = this.activeNotePath();
		if (initial) this.dispatch({ k: "focus", path: initial, t: Date.now() });
	}

	/**
	 * Close the open session and emit whatever it earned. Called from `onunload()` — a burst
	 * in progress when Obsidian quits is real work and must not be dropped on the floor.
	 * Synchronous by necessity (`onunload` is): the events land in the store's buffer and the
	 * caller flushes it.
	 */
	close(): void {
		this.dispatch({ k: "close", t: Date.now() });
	}

	/** For the "effort for this note" command — the seconds not yet written to the log. */
	pendingFor(path: string): { editMs: number; keys: number } {
		if (this.state.path !== path || this.state.start < 0) return { editMs: 0, keys: 0 };
		return { editMs: Math.max(0, this.state.last - this.state.start), keys: this.state.keys };
	}

	// ------------------------------------------------------------------ internals

	private dispatch(event: Parameters<typeof step>[1]): void {
		const result = step(this.state, event, this.host.timing());
		this.state = result.state;
		for (const emitted of result.emit) this.record(emitted);
	}

	private record(event: SignalEvent): void {
		if (this.excluded(event.p)) return;
		this.host.store.record(event);
	}

	private excluded(path: string): boolean {
		return isExcluded(path, this.host.excludeFolders());
	}

	/** The markdown note the user is actually looking at, or null. */
	private activeNotePath(): string | null {
		const view = this.host.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file ?? null;
		if (!file || file.extension !== "md") return null;
		if (this.excluded(file.path)) return null;
		return file.path;
	}
}

/**
 * The markdown note a leaf holds, or null when the leaf is not a note at all — a sidebar pane,
 * the graph, a canvas, this plugin's own view, or no leaf.
 *
 * `instanceof MarkdownView` rather than `getActiveViewOfType()`: the whole point is to tell
 * "the user switched to another NOTE" apart from "the user clicked something that is not a
 * note", and `getActiveViewOfType` collapses both to null. An excluded note is still a note —
 * the caller decides what to do about it.
 */
function leafNote(leaf: WorkspaceLeaf | null): TFile | null {
	const view = leaf?.view ?? null;
	if (!(view instanceof MarkdownView)) return null;
	const file = view.file;
	if (!(file instanceof TFile) || file.extension !== "md") return null;
	return file;
}
