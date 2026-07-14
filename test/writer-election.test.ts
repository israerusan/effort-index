/**
 * THE TWO-PLUGIN TEST — the one that decides whether this product does anything at all.
 *
 * Note Decay and Effort Index share one append-only signals log, and exactly one plugin may
 * append any given event. An earlier build elected that single writer PER PLUGIN, which was
 * wrong in a way that silently reduced Effort Index to a no-op: the two plugins do not emit
 * the same events.
 *
 *     Note Decay    emits open / rename / delete, and NEVER edit or dwell.
 *     Effort Index  emits edit / dwell — it is the only plugin in the suite that does.
 *
 * So whichever plugin recorded first owned the log, and every event the loser emitted was
 * dropped forever. When Note Decay won (a coin flip decided by listener-registration order,
 * re-rolled on every restart), `editMs` was ZERO for every note in the vault: "Most expensive
 * notes" was permanently empty and the CSV export said "No effort data to export yet".
 *
 * The election is now per EVENT KIND (SignalsBroker, SIGNALS_API_VERSION 2). This test stands
 * a note-decay-shaped store up FIRST, lets it take `open`, and then drives the REAL
 * EffortTracker through a real editing session — and asserts the edit and the dwell still land
 * on disk and still come back out of the fold. It fails against the old per-plugin broker.
 */
import assert from "node:assert";
import { MarkdownView, TFile } from "obsidian";
import type { App, Plugin } from "obsidian";
import { EffortTracker } from "../src/signals/EffortTracker";
import { SignalStore } from "../src/shared/signals/SignalStore";
import { SignalsBroker } from "../src/shared/signals/SignalsBroker";
import { parseSignalLog } from "../src/shared/signals/signalsAggregate.mjs";

// --- clock ------------------------------------------------------------------------------------
const T0 = 1_700_000_000_000;
let clock = T0;
const realNow = Date.now;
Date.now = () => clock;
const at = (ms: number): void => {
	clock = T0 + ms;
};

// --- browser globals the store and the tracker need --------------------------------------------
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

// --- one fake vault, shared by both plugins (that is the whole point) ---------------------------
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
		Promise.resolve({
			files: [...disk.keys()].filter((k) => k.startsWith(`${dir}/`)),
			folders: [] as string[],
		}),
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
let activeFile: TFile | null = null;

const app = {
	vault: Object.assign(vault, { configDir: ".obsidian", adapter, getMarkdownFiles: () => [] }),
	workspace: Object.assign(workspace, {
		getActiveViewOfType: (type: unknown) => (type === MarkdownView && activeFile ? { file: activeFile } : null),
	}),
} as unknown as App;

const plugin = {
	app,
	manifest: { id: "effort-index" },
	registerEvent: () => undefined,
	registerInterval: () => undefined,
	registerDomEvent: () => undefined,
} as unknown as Plugin;

const NOTE = "Projects/Roadmap.md";
const file = new TFile(NOTE);
const DECAY_LOG = ".obsidian/second-read/signals/decayshd.ndjson";
const EFFORT_LOG = ".obsidian/second-read/signals/effortsh.ndjson";

const TIMING = { idleCutoffMs: 60_000, minSessionMs: 5_000, dwellCapMs: 1_800_000, revisionGapMs: 1_800_000 };

async function main(): Promise<void> {
	// 1. Note Decay loads first and records an `open`. This is the coin flip that used to lose
	//    Effort Index the entire log. Its store is a REAL SignalStore under a different plugin
	//    id and a different shard — exactly what the vendored copy inside note-decay is.
	const decay = new SignalStore(app, "note-decay", "decayshd", TIMING);
	await decay.init();
	at(0);
	activeFile = file;
	decay.record({ t: Date.now(), k: "open", p: NOTE });
	await decay.flush();
	assert.equal(
		parseSignalLog(disk.get(DECAY_LOG) ?? "").events.length,
		1,
		"Note Decay got there first and its open is on disk"
	);

	// 2. Now Effort Index loads and the user works: 20 seconds of typing inside 100 seconds of
	//    wall clock, then they close the note.
	const store = new SignalStore(app, "effort-index", "effortsh", TIMING);
	await store.init();
	const tracker = new EffortTracker({
		plugin,
		store,
		timing: () => TIMING,
		excludeFolders: () => [],
	});
	tracker.start();

	workspace.emit("file-open", file);
	const editor = {};
	for (const t of [0, 10_000, 20_000]) {
		at(t);
		workspace.emit("editor-change", editor, { file });
	}
	at(100_000);
	assert.ok(tick !== null, "the dead-man tick must be registered");
	(tick as () => void)();
	at(120_000);
	tracker.close();
	await store.flush();

	// 3. THE ASSERTION THIS FILE EXISTS FOR. With Note Decay holding the slot it claimed first,
	//    Effort Index's own events must still reach the disk. Under the per-plugin election
	//    this shard did not exist at all.
	const ours = parseSignalLog(disk.get(EFFORT_LOG) ?? "");
	assert.equal(ours.malformed, 0);
	const edits = ours.events.filter((e) => e.k === "edit");
	const dwells = ours.events.filter((e) => e.k === "dwell");
	assert.equal(edits.length, 1, "our `edit` must be logged — with Note Decay installed, this was DROPPED");
	assert.equal((edits[0] as { ms: number }).ms, 20_000, "and it must still be 20 s of typing, not the wall clock");
	assert.equal(dwells.length, 1, "our `dwell` must be logged — nobody else in the suite emits it");

	// 4. And `open` is still single-writer: we listened for it, we emitted it, and it was NOT
	//    appended, because Note Decay already logs it. Removing the election to fix (3) would
	//    double-count exactly here.
	assert.equal(
		ours.events.filter((e) => e.k === "open").length,
		0,
		"an event BOTH plugins observe must be appended once, by its owner — not twice"
	);
	assert.equal(
		parseSignalLog(disk.get(DECAY_LOG) ?? "").events.filter((e) => e.k === "open").length,
		1,
		"...and Note Decay's copy is the one on disk"
	);
	// ...and the registry agrees about who owns what.
	assert.ok(SignalsBroker.isWriterFor("note-decay", "open"), "Note Decay owns `open`");
	assert.ok(SignalsBroker.isWriterFor("effort-index", "edit"), "we own `edit`");
	assert.ok(SignalsBroker.isWriterFor("effort-index", "dwell"), "we own `dwell`");
	assert.equal(SignalsBroker.isWriterFor("effort-index", "open"), false);
	assert.deepEqual(SignalsBroker.kindsOwnedBy("effort-index"), ["dwell", "edit"]);
	assert.deepEqual(SignalsBroker.kindsOwnedBy("note-decay"), ["open"]);

	// 5. The fold merges the two shards, so the view sees BOTH plugins' work as one vault.
	const index = await store.readIndex();
	assert.equal(index[NOTE].editMs, 20_000, "THE PRODUCT: measured editing time survives a Note Decay install");
	assert.ok(index[NOTE].dwellMs > 0, "so does dwell");
	assert.equal(index[NOTE].opens, 1, "and the open Note Decay wrote is folded in from ITS shard, exactly once");

	// 6. Cleanup — the registry is a process-wide global and the next test file elects into it.
	store.dispose();
	decay.dispose();
	SignalsBroker.releaseIfOwner("effort-index");
	SignalsBroker.releaseIfOwner("note-decay");
	assert.equal(SignalsBroker.registry(), null);
	Date.now = realNow;
}

export const done = main().then(undefined, (error: unknown) => {
	console.error(error);
	process.exit(1);
});
