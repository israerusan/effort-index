/**
 * WHAT THE PRO FEATURES DO WHEN THEY CANNOT RUN.
 *
 * A semantic feature has four ways to be unavailable — free tier, mobile, no engine installed,
 * engine broken — and one way to legitimately find nothing. All five produce an empty list, and
 * a UI that just renders the list tells the user the same thing in all five cases: "we looked,
 * and your vault is fine". That is true in exactly one of them. In the other four it is the lie
 * that makes a paid feature feel broken, and it is why this add-on must never ship a Pro panel
 * that can render empty without saying why.
 *
 * So: every report carries a state and a sentence, an empty `rows` is a FINDING only when the
 * state is "ok", and the one degradation with a next step (Pro + desktop + no engine) offers
 * the install — which opens the consent modal, and downloads nothing until it is confirmed.
 */
import assert from "node:assert";
import { FakeEl, TFile, notices } from "./obsidian-stub";
import { EffortAnalyst } from "../src/effortAnalysis";
import { EffortEngineIndex } from "../src/effortEngine";
import { EffortView } from "../src/ui/EffortView";
import { canInstallEngine, offerEngineInstall } from "../src/ui/engineInstall";
import { ENGINE_RELEASE_PINNED } from "../src/shared/engine/engineRelease.mjs";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { EngineStatus } from "../src/shared/engine/EngineHost";

/* --------------------------------------------------------------- test doubles -- */

const SIGNALS = {
	"Deep/Storage.md": { editMs: 9_000_000, editSessions: 4, revisions: 3, dwellMs: 0, lastOpen: 1, lastEdit: 1, firstSeen: 1, opens: 1 },
	"Deep/Recipes.md": { editMs: 5_000_000, editSessions: 2, revisions: 2, dwellMs: 0, lastOpen: 1, lastEdit: 1, firstSeen: 1, opens: 1 },
};

/** A host that is up and answers, so the "ok" path is exercised against the real code. */
class FakeHost {
	readonly sent: Array<{ method: string; params: Record<string, unknown> }> = [];
	constructor(private readonly hits: Record<string, Array<{ note: string; score: number }>> = {}) {}

	desktop = true;
	isAlive(): boolean {
		return true;
	}
	vaultKey(): string {
		return "vault";
	}
	/** A build for this machine exists — whether we are ALLOWED to fetch it is a separate question. */
	plan(): { version: string; url: string; sha256: string } | null {
		return { version: "1.0.0", url: "https://github.com/x/y.zip", sha256: "ab".repeat(32) };
	}
	planError(): string | null {
		return null;
	}
	engineLog(): string[] {
		return [];
	}
	ensureStarted(): Promise<{ model: string; dim: number }> {
		return Promise.resolve({ model: "all-MiniLM-L6-v2", dim: 384 });
	}
	cancel(): Promise<void> {
		return Promise.resolve();
	}
	request(method: string, params: Record<string, unknown>, options?: { onRequestId?: (id: number) => void }): Promise<unknown> {
		this.sent.push({ method, params });
		options?.onRequestId?.(this.sent.length);
		if (method !== "query") return Promise.resolve({});
		const self = String((params.exclude as string[])[0] ?? "");
		const hits = (this.hits[self] ?? []).map((hit) => ({
			key: "k",
			note: hit.note,
			ord: 0,
			score: hit.score,
			heading: "",
			preview: "…",
		}));
		return Promise.resolve({ results: [{ i: 0, hits }] });
	}
}

/** A host that is installed and immediately dies on every request. */
class DeadHost extends FakeHost {
	override request(): Promise<unknown> {
		return Promise.reject(new Error("The engine exited (code 1)."));
	}
}

function status(state: EngineStatus["state"]): EngineStatus {
	return {
		state,
		expectedVersion: "1.0.0",
		installed: state === "installed" || state === "running" ? { version: "1.0.0", target: "win-x64", sha256: "", exeSha256: "", installedAt: 0, exePath: "x" } : null,
		updateAvailable: false,
		byoPath: false,
		health: null,
	};
}

function context(options: {
	isPro?: boolean;
	host?: FakeHost | null;
	state?: EngineStatus["state"];
	signals?: Record<string, unknown>;
}) {
	const host = options.host === undefined ? new FakeHost() : options.host;
	const signals = options.signals ?? SIGNALS;
	const app = {
		vault: {
			cachedRead: () => Promise.resolve("# Storage\n\nA long paragraph about the storage engine and how it merges."),
			getMarkdownFiles: () => Object.keys(signals).map((path) => new TFile(path)),
			getFileByPath: (path: string) => (path in signals ? new TFile(path) : null),
		},
	};
	const ctx = {
		app,
		settings: { ...DEFAULT_SETTINGS, isPro: options.isPro ?? true },
		engine: host,
		engineIndex: new EffortEngineIndex(app as never, () => host as never),
		engineStatus: host ? status(options.state ?? "installed") : null,
		refreshEngineStatus: () => Promise.resolve(host ? status(options.state ?? "installed") : null),
		readSignals: () => Promise.resolve(signals as never),
		livePaths: () => new Set(Object.keys(signals)),
	};
	return ctx;
}

/* ------------------------------------------------------------------ the tests -- */

async function run(): Promise<void> {
	// --- 1. FREE TIER: gated, not broken. And nothing touches the engine. ---------------------
	{
		const ctx = context({ isPro: false });
		const analyst = new EffortAnalyst(ctx as never);
		const report = await analyst.orphans();

		assert.equal(report.state, "not-pro");
		assert.equal(report.rows.length, 0);
		assert.ok(report.message.length > 0, "a gated feature still says what it is");
		assert.equal(report.offerInstall, false);
		assert.equal((ctx.engine as FakeHost).sent.length, 0, "a free user must never start the engine");
	}

	// --- 2. MOBILE / no engine client: honest, and there is nothing to offer ---------------------
	{
		const ctx = context({ host: null });
		const report = await new EffortAnalyst(ctx as never).clusters();

		assert.equal(report.state, "unsupported");
		assert.equal(report.clusters.length, 0);
		assert.match(report.message, /desktop only/i);
		assert.match(report.message, /works here/i, "and it says the free tier still works");
		assert.equal(report.offerInstall, false, "there is nothing to install on a phone");
	}

	// --- 3. THE ONE WITH A NEXT STEP: Pro, desktop, no engine installed ---------------------------
	{
		const ctx = context({ state: "not-installed" });
		const report = await new EffortAnalyst(ctx as never).orphans();

		assert.equal(report.state, "not-installed");
		assert.equal(report.rows.length, 0, "and it must be EMPTY — not guessed at, not half-computed");
		assert.equal(report.offerInstall, true, "this is the one degradation the user can act on");
		assert.match(report.message, /not installed/i);
		assert.match(report.message, /meaning/i, "it says WHY the feature needs the engine");
		assert.equal((ctx.engine as FakeHost).sent.length, 0, "and it does not start, download, or half-run anything");
	}

	// --- 4. the engine is installed and DIES: an error, never "no findings" ------------------------
	{
		const ctx = context({ host: new DeadHost() });
		const report = await new EffortAnalyst(ctx as never).orphans();

		assert.equal(report.state, "engine-error");
		assert.equal(report.rows.length, 0);
		assert.equal(report.analysed, 0);
		assert.ok(
			!/no orphan/i.test(report.message),
			"a crashed engine must NEVER be reported as a clean bill of health"
		);
		assert.match(report.message, /could not be indexed|could not analyse/i);
	}

	// --- 5. no measured effort yet: a data state, not an engine state --------------------------------
	{
		const ctx = context({ signals: {} });
		const report = await new EffortAnalyst(ctx as never).orphans();
		assert.equal(report.state, "no-data");
		assert.equal(report.offerInstall, false);
		assert.match(report.message, /measured editing time/i);
		assert.equal((ctx.engine as FakeHost).sent.length, 0, "nothing to analyse ⇒ no engine start");
	}

	// --- 6. THE HAPPY PATH, including the empty-but-true one ------------------------------------------
	{
		// Both notes have a close neighbour: nothing is orphaned, and the report SAYS so.
		const ctx = context({
			host: new FakeHost({
				"Deep/Storage.md": [{ note: "Deep/Recipes.md", score: 0.82 }],
				"Deep/Recipes.md": [{ note: "Deep/Storage.md", score: 0.82 }],
			}),
		});
		const report = await new EffortAnalyst(ctx as never).orphans();

		assert.equal(report.state, "ok");
		assert.equal(report.rows.length, 0, "genuinely nothing orphaned");
		assert.equal(report.analysed, 2, "and both notes were actually looked at");
		assert.match(report.message, /Analysed 2 expensive notes/);
		assert.match(report.message, /none of that work is orphaned/i, "an empty OK result is a sentence, not a blank");

		// The vault was indexed before anything was queried — against an EMPTY index every note
		// looks orphaned, which is the worst false positive this feature can produce.
		const host = ctx.engine as FakeHost;
		const firstQuery = host.sent.findIndex((frame) => frame.method === "query");
		const upserts = host.sent.filter((frame) => frame.method === "upsert").length;
		assert.equal(upserts, 2, "every note in the vault is embedded first");
		assert.ok(
			host.sent.slice(0, firstQuery).some((frame) => frame.method === "upsert"),
			"the index is built BEFORE the first query, or the answer is garbage"
		);
		assert.equal(host.sent[0].method, "open", "and the vault's index is opened first of all");
	}

	// --- 7. a real orphan is found, and named -----------------------------------------------------------
	{
		const ctx = context({
			host: new FakeHost({
				"Deep/Storage.md": [{ note: "Deep/Recipes.md", score: 0.11 }],
				"Deep/Recipes.md": [{ note: "Deep/Storage.md", score: 0.11 }],
			}),
		});
		const report = await new EffortAnalyst(ctx as never).orphans();
		assert.equal(report.state, "ok");
		assert.deepEqual(
			report.rows.map((row) => row.path),
			["Deep/Storage.md", "Deep/Recipes.md"],
			"both are below 0.45, most expensive first"
		);
		assert.equal(report.rows[0].bestScore, 0.11);
		assert.equal(report.rows[0].bestNote, "Deep/Recipes.md");
		assert.match(report.message, /the time went in, and the ideas never came out/);
	}

	// --- 8. THE VIEW: a Pro user with no engine sees the REASON, and the only honest next step ---------
	//
	// Which next step is honest depends on the build. This release ships UNPINNED — every asset
	// checksum in engineRelease.mjs is still the 64-zero placeholder — so there is nothing to
	// verify a download against, and downloading an unverifiable executable is the single thing
	// this whole design exists to prevent. A build in that state must therefore NOT offer a
	// download button; it must say, in words, that no engine build is published yet.
	//
	// Both assertions below are written against ENGINE_RELEASE_PINNED rather than against `false`,
	// so they keep holding — and start demanding the button — the moment `pin-engine.mjs` runs.
	{
		const ctx = context({ state: "not-installed" });
		const plugin = {
			...ctx,
			analyst: new EffortAnalyst(ctx as never),
			engineAvailable: () => true,
			canRunSemanticPro: () => false,
		};
		const view = new EffortView({} as never, plugin as never);
		await view.show("orphans");

		const root = view.contentEl as unknown as FakeEl;
		const text = root.text();
		assert.match(text, /not installed/i, "the panel says the engine is missing");
		assert.match(text, /meaning/i, "and why the feature needs it");
		assert.ok(
			!/nothing yet|no orphan|none of that work/i.test(text),
			"and it does NOT render an empty list that reads as 'we looked and found nothing'"
		);

		assert.equal(
			canInstallEngine(plugin as never),
			ENGINE_RELEASE_PINNED,
			"a build may offer a download if, and only if, it has a checksum to verify it against"
		);

		const install = root.find((el) => el.classes.has("effort-index-install"));
		assert.equal(
			Boolean(install),
			ENGINE_RELEASE_PINNED,
			ENGINE_RELEASE_PINNED
				? "a pinned build must offer the install — the one actionable degradation"
				: "an unpinned build must NOT show a download button it would refuse to honour"
		);

		if (ENGINE_RELEASE_PINNED) {
			assert.equal(install?.textContent, "Install the engine");
			assert.match(text, /SHA-256/, "and promises the checksum is shown before anything is downloaded");
		} else {
			assert.match(
				text,
				/No engine build is published for this release yet/,
				"an unpinned build says so plainly instead of dangling a dead button"
			);
			assert.match(text, /everything else in this add-on works now/i);
		}

		// Nothing has been downloaded, started, or queried by RENDERING any of this.
		assert.equal((ctx.engine as FakeHost).sent.length, 0);
	}

	// --- 8b. and the install path itself cannot be tricked into downloading an unverifiable binary ------
	{
		const ctx = context({ state: "not-installed" });
		const opened: string[] = [];
		const before = notices.length;
		// Drive the real consent path. On an unpinned build it must refuse and say why — it must NOT
		// open the modal, because confirming that modal would start a download with no checksum.
		offerEngineInstall({ ...ctx, onEngineInstalled: () => Promise.resolve() } as never, {
			onDone: () => opened.push("done"),
		});
		if (!ENGINE_RELEASE_PINNED) {
			assert.ok(notices.length > before, "it tells the user why nothing happened");
			assert.match(
				notices[notices.length - 1],
				/No engine build is published|desktop only/,
				"and the reason is the real one"
			);
			assert.equal((ctx.engine as FakeHost).sent.length, 0, "and NOTHING was fetched or spawned");
		}
	}

	// --- 9. THE VIEW, free tier: a locked tab and a pitch — with no dead purchase button -----------------
	{
		const ctx = context({ isPro: false });
		const plugin = {
			...ctx,
			analyst: new EffortAnalyst(ctx as never),
			engineAvailable: () => true,
			canRunSemanticPro: () => false,
		};
		const view = new EffortView({} as never, plugin as never);
		await view.show("orphans");

		const root = view.contentEl as unknown as FakeEl;
		assert.equal(root.findAll((el) => el.tag === "a").length, 0, "no purchase link while there is no checkout");
		assert.match(root.text(), /Purchasing is not open yet/);
		assert.ok(
			root.find((el) => el.classes.has("effort-index-mode") && el.classes.has("is-locked")),
			"the Pro tab is visibly locked rather than hidden"
		);
		assert.equal((ctx.engine as FakeHost).sent.length, 0, "a free user's click starts no engine");
	}

	// --- 10. clustering degrades the same way ---------------------------------------------------------
	{
		const ctx = context({ state: "not-installed" });
		const report = await new EffortAnalyst(ctx as never).clusters();
		assert.equal(report.state, "not-installed");
		assert.equal(report.clusters.length, 0);
		assert.equal(report.ungrouped.length, 0, "an ungrouped list would read as a result");
		assert.equal(report.offerInstall, true);
	}
}

export const done = run();
