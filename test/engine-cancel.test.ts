/**
 * SUPERSEDED WORK IS CANCELLED AT THE ENGINE (DESIGN 6.2, method 8).
 *
 * An orphan scan is one query PER EXPENSIVE NOTE — forty of them by default, each a full vault
 * scan inside the sidecar. If the user re-runs it, switches tab, or closes the panel, every one
 * of those still in flight keeps burning a core to compute an answer that will be thrown away.
 *
 * The generation counter is what makes it CORRECT (a stale report can never overwrite a fresh
 * one). The `cancel` RPC is what makes it cheap. Both are needed, and the second one is the one
 * that rots silently: it depends on `EngineHost.request({ onRequestId })` handing the id back
 * SYNCHRONOUSLY, before the frame is written to stdin, because a single-text query emits no
 * progress notification and there is no other moment at which the id could ever be learnt. A
 * sibling add-on shipped a cancel path wired to `onProgress` and it was dead code for a release.
 *
 * This drives the REAL EffortEngineIndex and the REAL EffortAnalyst over a fake transport.
 */
import assert from "node:assert";
import { TFile } from "./obsidian-stub";
import { EffortAnalyst } from "../src/effortAnalysis";
import { EffortEngineIndex } from "../src/effortEngine";
import { EngineRpcError, ERROR_CODES } from "../src/shared/engine/protocol.mjs";
import { DEFAULT_SETTINGS } from "../src/settings";

interface Deferred {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

/**
 * The transport, as the engine actually behaves: `request()` allocates an id, reports it
 * synchronously, and then takes as long as it likes. A query that resolves instantly can never
 * BE superseded, so nothing here resolves until the test says so.
 */
class FakeHost {
	readonly sent: Array<{ id: number; method: string }> = [];
	readonly cancelled: number[] = [];
	private readonly pending = new Map<number, Deferred>();
	private nextId = 1;
	/** Once set, queries answer instantly — so a test can let a run finish instead of hanging. */
	private answering = false;

	desktop = true;
	isAlive(): boolean {
		return true;
	}
	vaultKey(): string {
		return "vault";
	}
	ensureStarted(): Promise<{ model: string; dim: number }> {
		return Promise.resolve({ model: "all-MiniLM-L6-v2", dim: 384 });
	}

	request(method: string, _params: unknown, options?: { onRequestId?: (id: number) => void }): Promise<unknown> {
		const id = this.nextId++;
		this.sent.push({ id, method });
		options?.onRequestId?.(id); // the real EngineHost fires this BEFORE the stdin write
		if (method !== "query") return Promise.resolve({});
		if (this.answering) return Promise.resolve({ results: [{ i: 0, hits: [] }] });
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
	}

	cancel(id: number): Promise<void> {
		this.cancelled.push(id);
		const deferred = this.pending.get(id);
		if (deferred) {
			this.pending.delete(id);
			deferred.reject(new EngineRpcError(ERROR_CODES.CANCELLED, "Superseded."));
		}
		return Promise.resolve();
	}

	/** Let everything in flight — and everything that follows — complete. */
	answerEverything(): void {
		this.answering = true;
		for (const [id, deferred] of [...this.pending]) {
			this.pending.delete(id);
			deferred.resolve({ results: [{ i: 0, hits: [] }] });
		}
	}

	queryIds(): number[] {
		return this.sent.filter((frame) => frame.method === "query").map((frame) => frame.id);
	}
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const SIGNALS = {
	"A.md": { editMs: 9_000_000, editSessions: 1, revisions: 1, dwellMs: 0, lastOpen: 1, lastEdit: 1, firstSeen: 1, opens: 1 },
	"B.md": { editMs: 8_000_000, editSessions: 1, revisions: 1, dwellMs: 0, lastOpen: 1, lastEdit: 1, firstSeen: 1, opens: 1 },
};

function harness(host: FakeHost) {
	const app = {
		vault: {
			cachedRead: () => Promise.resolve("A paragraph long enough to survive the chunker's minimum, about storage."),
			getMarkdownFiles: () => Object.keys(SIGNALS).map((path) => new TFile(path)),
			getFileByPath: (path: string) => (path in SIGNALS ? new TFile(path) : null),
		},
	};
	const engineIndex = new EffortEngineIndex(app as never, () => host as never);
	const ctx = {
		app,
		settings: { ...DEFAULT_SETTINGS, isPro: true },
		engine: host,
		engineIndex,
		engineStatus: { state: "installed" as const, expectedVersion: "1", installed: null, updateAvailable: false, byoPath: false, health: null },
		refreshEngineStatus: () => Promise.resolve(null),
		readSignals: () => Promise.resolve(SIGNALS as never),
		livePaths: () => new Set(Object.keys(SIGNALS)),
	};
	return { engineIndex, analyst: new EffortAnalyst(ctx as never) };
}

async function run(): Promise<void> {
	// --- 1. the request id reaches us, synchronously, for a plain query --------------------------
	// The contract the whole cancel path stands on. No progress notification is emitted — because
	// the real engine does not emit one for a query.
	{
		const host = new FakeHost();
		const { engineIndex } = harness(host);

		const probe = engineIndex.probeReuse(new TFile("A.md"), 3);
		await settle();

		assert.equal(host.queryIds().length, 1, "a query frame went out");
		assert.equal(engineIndex.inflightCount(), 1, "and its id is registered as cancellable");

		engineIndex.cancelInflight();
		assert.deepEqual(host.cancelled, host.queryIds(), "cancelInflight sends a real cancel frame for it");

		const result = await probe;
		assert.equal(result.ok, false, "the cancelled query does not become a result");
		assert.equal(engineIndex.inflightCount(), 0, "and the id is not leaked");
		assert.equal(engineIndex.error, undefined, "a cancel we asked for is NOT an engine error");
	}

	// --- 2. a second analysis CANCELS the first one's in-flight work -------------------------------
	{
		const host = new FakeHost();
		const { analyst } = harness(host);

		const first = analyst.orphans();
		await settle();
		await settle();

		const inFlight = host.queryIds();
		assert.ok(inFlight.length >= 1, "the first scan is querying the engine");
		assert.deepEqual(host.cancelled, [], "nothing to cancel yet");

		// The user hit "Run again" (or switched tab). The old scan's answers are now answers to a
		// question nobody is asking — and the engine is still computing them.
		const second = analyst.orphans();

		assert.ok(
			inFlight.every((id) => host.cancelled.includes(id)),
			`every superseded query must be cancelled at the engine — cancelled ${String(host.cancelled)}, expected ${String(inFlight)}`
		);

		const firstReport = await first;
		assert.equal(firstReport.state, "cancelled", "and the superseded run reports as cancelled…");
		assert.equal(firstReport.rows.length, 0, "…with no rows, rather than a partial report");
		assert.ok(!/orphan/i.test(firstReport.message) || /superseded/i.test(firstReport.message));

		// Let the second one finish, so the run is a real supersede rather than two dead scans.
		host.answerEverything();
		const secondReport = await second;
		assert.equal(secondReport.state, "ok", "the NEWEST scan is the one that produces the report");
	}

	// --- 3. cancel() on unload stops the scan dead --------------------------------------------------
	{
		const host = new FakeHost();
		const { analyst, engineIndex } = harness(host);

		const running = analyst.orphans();
		await settle();
		await settle();
		const inFlight = host.queryIds();
		assert.ok(inFlight.length >= 1);

		analyst.cancel(); // what onunload() and EffortView.onClose() call

		assert.ok(
			inFlight.every((id) => host.cancelled.includes(id)),
			"unloading the plugin must not leave the sidecar scanning the vault for a panel that is gone"
		);
		const report = await running;
		assert.equal(report.state, "cancelled");
		assert.equal(engineIndex.inflightCount(), 0);
	}
}

export const done = run();
