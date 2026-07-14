/**
 * THE WIRING TEST. Everything else in this suite tests a pure function; this one tests the
 * plugin.
 *
 * It runs the REAL `EffortTracker` and the REAL vendored `SignalStore` against a fake vault
 * and a fake clock, drives them with the actual Obsidian events Obsidian would fire, and then
 * reads the NDJSON that ended up "on disk". A green unit suite proves the rules are right; it
 * does not prove a single listener is attached, that the writer election ever fires, or that
 * one byte is ever written. This does.
 *
 * The load-bearing assertion is the same one as always, but end to end: 110 seconds of wall
 * clock containing 20 seconds of typing must write 20 seconds to the log.
 */
import assert from "node:assert";
import { MarkdownView, TFile } from "obsidian";
import type { App, Plugin } from "obsidian";
import { EffortTracker } from "../src/signals/EffortTracker";
import { SignalStore } from "../src/shared/signals/SignalStore";
import { SignalsBroker } from "../src/shared/signals/SignalsBroker";
import { foldSignals, parseSignalLog } from "../src/shared/signals/signalsAggregate.mjs";

// --- a fake clock ---------------------------------------------------------------------------
// The tracker reads Date.now() internally (it must — the events are real-time). Owning the
// clock is the only way to assert on an idle cutoff without sleeping for 60 real seconds.
let clock = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => clock;
const at = (ms: number): void => {
	clock = 1_700_000_000_000 + ms;
};

// SignalStore debounces its writes through window.setTimeout, and the tracker's dead-man check
// is a window.setInterval. Node has no `window` — without this the plugin would throw on the
// first recorded event, which is itself worth knowing: these are the only two browser globals
// the free tier touches.
/** The dead-man tick, captured rather than scheduled — so the test drives the EXACT callback
 *  the plugin registered, instead of a private method that only the test knows about. */
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
// `activeWindow` is an Obsidian-declared global (the popout-aware window), always present in
// the renderer. The blur/focus dwell listeners are attached to it.
(globalThis as Record<string, unknown>).activeWindow = (globalThis as Record<string, unknown>).window;

// --- a fake vault ----------------------------------------------------------------------------
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

// --- a fake workspace/vault event bus ----------------------------------------------------------
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
	/** Proves a listener is actually attached — a tracker that registered nothing would
	 *  otherwise sail through every assertion below by recording nothing at all. */
	count(name: string): number {
		return (this.handlers.get(name) ?? []).length;
	}
}

const workspace = new Bus();
const vault = new Bus();
let activeFile: TFile | null = null;

const app = {
	vault: Object.assign(vault, {
		configDir: ".obsidian",
		adapter,
		getMarkdownFiles: () => [],
	}),
	workspace: Object.assign(workspace, {
		getActiveViewOfType: (type: unknown) => (type === MarkdownView && activeFile ? { file: activeFile } : null),
	}),
} as unknown as App;

const intervals: number[] = [];
const plugin = {
	app,
	manifest: { id: "effort-index" },
	registerEvent: () => undefined,
	registerInterval: (id: number) => intervals.push(id),
	registerDomEvent: () => undefined,
} as unknown as Plugin;

// --- run it ------------------------------------------------------------------------------------
const NOTE = "Projects/Roadmap.md";
const file = new TFile(NOTE);

const store = new SignalStore(app, "effort-index", "testshrd", {
	idleCutoffMs: 60_000,
	minSessionMs: 5_000,
	dwellCapMs: 1_800_000,
	revisionGapMs: 1_800_000,
});

const tracker = new EffortTracker({
	plugin,
	store,
	timing: () => ({
		idleCutoffMs: 60_000,
		minSessionMs: 5_000,
		dwellCapMs: 1_800_000,
	}),
	excludeFolders: () => ["Templates"],
});

async function main(): Promise<void> {
	await store.init();
	tracker.start();

	// 1. The listeners actually exist.
	assert.ok(workspace.count("editor-change") > 0, "the tracker must listen for editor-change");
	assert.ok(workspace.count("file-open") > 0, "the tracker must listen for file-open");
	assert.ok(workspace.count("active-leaf-change") > 0, "the tracker must listen for active-leaf-change");
	assert.ok(vault.count("rename") > 0 && vault.count("delete") > 0, "rename/delete must be tracked");
	assert.equal(intervals.length, 1, "the dead-man tick must be registered (and cleaned up by Obsidian)");

	// 2. The user opens a note and types for 20 seconds, then walks away for 90.
	at(0);
	activeFile = file;
	workspace.emit("file-open", file);

	const editor = {};
	at(0);
	workspace.emit("editor-change", editor, { file });
	at(10_000);
	workspace.emit("editor-change", editor, { file });
	at(20_000);
	workspace.emit("editor-change", editor, { file });

	// ...silence. The 5s tick keeps firing; only the one past the cutoff closes the burst.
	assert.ok(tick !== null, "the dead-man tick callback must have been registered");
	for (const t of [25_000, 60_000, 85_000, 110_000]) {
		at(t);
		// The REAL interval callback the plugin registered — not a private method reached into
		// from the test. Driving it by hand rather than waiting 110 real seconds.
		(tick as () => void)();
	}

	await store.flush();

	// 3. THE INVARIANT, on the bytes that actually hit the disk.
	const logPath = ".obsidian/second-read/signals/testshrd.ndjson";
	const raw = disk.get(logPath) ?? "";
	assert.ok(raw.length > 0, "the store must have written the log through the adapter");

	const parsed = parseSignalLog(raw);
	assert.equal(parsed.malformed, 0, "every line the plugin wrote must parse");

	const opens = parsed.events.filter((e) => e.k === "open");
	const edits = parsed.events.filter((e) => e.k === "edit");
	assert.equal(opens.length, 1, "file-open recorded exactly one open event");
	assert.equal(edits.length, 1, "the burst closed exactly once");
	assert.equal(
		(edits[0] as { ms: number }).ms,
		20_000,
		"END TO END: 110 seconds of wall clock containing 20 seconds of typing wrote 20 seconds"
	);

	const index = foldSignals(parsed.events, null, { minSessionMs: 5_000 });
	assert.equal(index[NOTE].editMs, 20_000, "...and the fold agrees");
	assert.equal(index[NOTE].opens, 1);
	assert.ok(index[NOTE].lastOpen > 0, "lastOpen is recorded — this is what Note Decay reads");

	// 4. The single-writer election really happened (this is what stops double-counting when
	//    Note Decay is installed alongside). The slot is PER KIND — see writer-election.test.ts
	//    for the two-plugin case; here we only assert this plugin owns the kinds it emits.
	assert.ok(SignalsBroker.isWriter("effort-index"), "this plugin claimed a writer slot");
	assert.deepEqual(
		SignalsBroker.kindsOwnedBy("effort-index"),
		["edit", "open"],
		"it claims exactly the kinds it has actually emitted — nothing pre-emptively"
	);
	assert.ok(SignalsBroker.isWriterFor("effort-index", "edit"), "`edit` is ours: nobody else emits it");

	// 5. An excluded folder is never recorded at all.
	const template = new TFile("Templates/Daily.md");
	at(200_000);
	activeFile = template;
	workspace.emit("file-open", template);
	at(210_000);
	workspace.emit("editor-change", editor, { file: template });
	at(240_000);
	workspace.emit("editor-change", editor, { file: template });
	at(400_000);
	(tick as () => void)();
	await store.flush();

	const after = parseSignalLog(disk.get(logPath) ?? "");
	assert.ok(
		!after.events.some((e) => e.p.startsWith("Templates/")),
		"an excluded folder must never reach the log — not one event"
	);

	// 6. onunload's release lets a surviving Second Read plugin take over the log.
	store.dispose();
	SignalsBroker.releaseIfOwner("effort-index");
	assert.equal(SignalsBroker.isWriter("effort-index"), false, "every writer slot is released on unload");
	assert.deepEqual(SignalsBroker.kindsOwnedBy("effort-index"), []);
	assert.equal(SignalsBroker.registry(), null, "and the global goes with the last owner");

	Date.now = realNow;
}

// NOT top-level await: esbuild's CJS output rejects it outright (the same invariant main.js
// lives under). So the async body is kicked off and the promise is EXPORTED — test/run.mjs
// awaits `done` before it loads the next test. An async test that nobody awaited would
// otherwise "pass" by never running a single assertion, and would run interleaved with the
// next test against the same global writer registry.
export const done = main().then(undefined, (error: unknown) => {
	console.error(error);
	process.exit(1);
});
