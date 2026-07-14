/**
 * `active-leaf-change` fires for EVERY leaf — including this plugin's own sidebar panel.
 *
 * The bug this file locks down: the tracker used to answer "which note is active?" with
 * `getActiveViewOfType(MarkdownView)`, which returns null the moment a non-markdown leaf is
 * focused. Clicking the file explorer, the search pane, the graph — or the "Expensive notes"
 * panel this plugin itself puts in the sidebar — therefore dispatched a `close`, which ends the
 * editing session. And `closeBurst` DISCARDS any burst shorter than `minSessionMs` outright.
 *
 * So: type for four seconds, click our own panel, type four seconds more, go idle. Two bursts
 * of 4 s, both under the 5 s floor, both thrown away. Eight seconds of real work recorded as
 * ZERO — by the user doing the single most natural thing in the plugin.
 *
 * A leaf change into something that is not a note is now treated exactly like a window blur:
 * dwell pauses, the burst stays open, and the dead-man tick still closes it on the idle rule.
 * A leaf change into a DIFFERENT note still closes the session, which is what the listener is
 * there for in the first place — phase 2 asserts that, so the fix cannot be "delete the
 * listener".
 */
import assert from "node:assert";
import { ItemView, MarkdownView, TFile } from "obsidian";
import type { App, Plugin } from "obsidian";
import { EffortTracker } from "../src/signals/EffortTracker";
import { SignalStore } from "../src/shared/signals/SignalStore";
import { SignalsBroker } from "../src/shared/signals/SignalsBroker";
import { parseSignalLog } from "../src/shared/signals/signalsAggregate.mjs";

const T0 = 1_700_000_000_000;
let clock = T0;
const realNow = Date.now;
Date.now = () => clock;
const at = (ms: number): void => {
	clock = T0 + ms;
};

let tick: (() => void) | null = null;
(globalThis as Record<string, unknown>).window = {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: number) => clearTimeout(id),
	setInterval: (fn: () => void) => {
		tick = fn;
		return 1;
	},
	clearInterval: () => undefined,
};
(globalThis as Record<string, unknown>).activeWindow = (globalThis as Record<string, unknown>).window;

const disk = new Map<string, string>();
const adapter = {
	exists: (p: string) => Promise.resolve(disk.has(p)),
	mkdir: (p: string) => {
		disk.set(p, "");
		return Promise.resolve();
	},
	read: (p: string) => Promise.resolve(disk.get(p) ?? ""),
	write: (p: string, data: string) => {
		disk.set(p, data);
		return Promise.resolve();
	},
	append: (p: string, data: string) => {
		disk.set(p, (disk.get(p) ?? "") + data);
		return Promise.resolve();
	},
	list: (dir: string) =>
		Promise.resolve({ files: [...disk.keys()].filter((k) => k.startsWith(`${dir}/`)), folders: [] as string[] }),
	remove: (p: string) => {
		disk.delete(p);
		return Promise.resolve();
	},
};

type Handler = (...args: unknown[]) => void;
class Bus {
	private handlers = new Map<string, Handler[]>();
	on(name: string, handler: Handler): { name: string } {
		const list = this.handlers.get(name) ?? [];
		list.push(handler);
		this.handlers.set(name, list);
		return { name };
	}
	emit(name: string, ...args: unknown[]): void {
		for (const handler of this.handlers.get(name) ?? []) handler(...args);
	}
}

const workspace = new Bus();
const vault = new Bus();

/**
 * THE HONEST BIT. Obsidian has ONE active leaf, and `getActiveViewOfType(MarkdownView)` is
 * derived from it: when the active leaf holds a sidebar pane, it returns NULL — it does not
 * return the note you were last looking at. That is the entire mechanism of the bug, so the
 * fake must model it or the test proves nothing (an earlier draft of this file kept a separate
 * `activeFile` that a leaf change never touched, and it passed against the broken tracker).
 */
let activeLeaf: { view: unknown } | null = null;

const app = {
	vault: Object.assign(vault, { configDir: ".obsidian", adapter, getMarkdownFiles: () => [] }),
	workspace: Object.assign(workspace, {
		getActiveViewOfType: (type: unknown) => {
			const view = activeLeaf?.view;
			return typeof type === "function" && view instanceof (type as new () => unknown) ? view : null;
		},
	}),
} as unknown as App;

/** Focus a leaf the way Obsidian does: the active leaf moves, THEN the event fires. */
function focusLeaf(leaf: { view: unknown }): void {
	activeLeaf = leaf;
	workspace.emit("active-leaf-change", leaf);
}

const plugin = {
	app,
	manifest: { id: "effort-index" },
	registerEvent: () => undefined,
	registerInterval: () => undefined,
	registerDomEvent: () => undefined,
} as unknown as Plugin;

const A = "Projects/Roadmap.md";
const B = "Projects/Notes.md";
const fileA = new TFile(A);
const fileB = new TFile(B);
const LOG = ".obsidian/second-read/signals/leafshrd.ndjson";

const TIMING = { idleCutoffMs: 60_000, minSessionMs: 5_000, dwellCapMs: 1_800_000, revisionGapMs: 1_800_000 };

/** A leaf holding a real note — what Obsidian hands the listener when you click another tab. */
function noteLeaf(file: TFile): { view: unknown } {
	const view = new MarkdownView(null);
	(view as unknown as { file: TFile }).file = file;
	return { view };
}

/** A leaf holding anything that is NOT a note: the file explorer, the graph, the search pane —
 *  or this plugin's own EffortView, which extends ItemView exactly like this. */
function sidebarLeaf(): { view: unknown } {
	return { view: new ItemView(null) };
}

function editsFor(path: string): Array<{ ms: number }> {
	const parsed = parseSignalLog(disk.get(LOG) ?? "");
	assert.equal(parsed.malformed, 0, "every line written must parse");
	return parsed.events.filter((e) => e.k === "edit" && e.p === path) as unknown as Array<{ ms: number }>;
}

async function main(): Promise<void> {
	const store = new SignalStore(app, "effort-index", "leafshrd", TIMING);
	await store.init();
	const tracker = new EffortTracker({ plugin, store, timing: () => TIMING, excludeFolders: () => [] });
	tracker.start();

	const editor = {};

	// --- PHASE 1: the reported failure, exactly -------------------------------------------------
	at(0);
	const leafA = noteLeaf(fileA);
	activeLeaf = leafA;
	workspace.emit("file-open", fileA);

	at(0);
	workspace.emit("editor-change", editor, { file: fileA });
	at(4_000);
	workspace.emit("editor-change", editor, { file: fileA }); // 4 s of typing — under the 5 s floor

	// The user clicks the plugin's own "Expensive notes" panel to look something up. Obsidian
	// fires active-leaf-change with a leaf whose view is NOT a MarkdownView.
	at(5_000);
	focusLeaf(sidebarLeaf());

	// ...and clicks back into the note and keeps typing. (No file-open: the file never changed.)
	at(6_000);
	focusLeaf(leafA);
	at(6_000);
	workspace.emit("editor-change", editor, { file: fileA });
	at(8_000);
	workspace.emit("editor-change", editor, { file: fileA }); // 4 s more

	// Then they stop. The dead-man tick closes the burst on the idle rule.
	at(70_000);
	assert.ok(tick !== null, "the dead-man tick must be registered");
	(tick as () => void)();
	await store.flush();

	const banked = editsFor(A);
	assert.equal(banked.length, 1, "the burst survived the sidebar click as ONE burst, and closed once");
	assert.equal(
		banked[0].ms,
		8_000,
		"THE BUG: 8 s of real editing, split by a click on this plugin's OWN panel, was recorded as 0"
	);

	// --- PHASE 2: a leaf change to ANOTHER NOTE must still end the session ----------------------
	// The listener exists because `file-open` does not fire when you move between two leaves that
	// already hold files. Deleting it would be the wrong fix, so prove it still works.
	at(80_000);
	workspace.emit("editor-change", editor, { file: fileA });
	at(86_000);
	workspace.emit("editor-change", editor, { file: fileA }); // a 6 s burst, still open

	at(90_000);
	focusLeaf(noteLeaf(fileB));
	await store.flush();

	const afterSwitch = editsFor(A);
	assert.equal(afterSwitch.length, 2, "switching to another note closes the burst there and then");
	assert.equal(afterSwitch[1].ms, 6_000, "...billing the keystroke span, not the wall clock");

	const dwells = parseSignalLog(disk.get(LOG) ?? "").events.filter((e) => e.k === "dwell");
	assert.ok(
		dwells.some((e) => e.p === A),
		"and dwell on the note we left is closed out — it does not keep accruing behind the new one"
	);

	// The timer really did move to B: a keystroke there opens a burst against B, not A.
	at(95_000);
	workspace.emit("editor-change", editor, { file: fileB });
	at(101_000);
	workspace.emit("editor-change", editor, { file: fileB });
	at(120_000);
	tracker.close();
	await store.flush();

	const onB = editsFor(B);
	assert.equal(onB.length, 1, "the new note gets its own burst");
	assert.equal(onB[0].ms, 6_000);
	assert.equal(editsFor(A).length, 2, "and nothing more is billed to the note we left");

	store.dispose();
	SignalsBroker.releaseIfOwner("effort-index");
	Date.now = realNow;
}

export const done = main().then(undefined, (error: unknown) => {
	console.error(error);
	process.exit(1);
});
