import { Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { resolveLicenseTransition } from "./shared/licenseTransition.mjs";
import { SignalStore, newWriterId } from "./shared/signals/SignalStore";
import { SignalsBroker } from "./shared/signals/SignalsBroker";
import type { SignalsIndex } from "./shared/signals/signalsAggregate.d.mts";
import { EngineBroker } from "./shared/engine/EngineBroker";
import type { EngineHost, EngineStatus } from "./shared/engine/EngineHost";
import { LicenseManager } from "./license/LicenseManager";
import { EffortTracker } from "./signals/EffortTracker";
import { EffortEngineIndex } from "./effortEngine";
import { EffortAnalyst } from "./effortAnalysis";
import { DEFAULT_SETTINGS, coerceSettings, timingOptions, type EffortIndexSettings } from "./settings";
import { EffortIndexSettingTab } from "./ui/SettingsTab";
import { EffortView, VIEW_TYPE_EFFORT } from "./ui/EffortView";
import { registerCommands } from "./commands";

/** How long a burst of continuous setting changes is coalesced before a write. */
const SAVE_DEBOUNCE_MS = 400;

export default class EffortIndexPlugin extends Plugin {
	settings: EffortIndexSettings = { ...DEFAULT_SETTINGS };
	signals!: SignalStore;
	tracker!: EffortTracker;

	/**
	 * The SHARED semantic engine, or null on mobile / an unsupported platform / when an
	 * incompatible engine client is already in the realm.
	 *
	 * Obtained from `EngineBroker`, never constructed here. Five Second Read add-ons in one
	 * renderer must share ONE sidecar process: five would mean five ONNX runtimes, five copies of
	 * the index, five Defender scans and one uninstall. Acquiring is cheap and spawns NOTHING —
	 * the child starts lazily, on the first request, and only if an engine is installed.
	 */
	engine: EngineHost | null = null;
	engineIndex!: EffortEngineIndex;
	analyst!: EffortAnalyst;
	/** Cached because reading it touches the disk and display() is synchronous. */
	engineStatus: EngineStatus | null = null;

	/** Why the pasted key did not work, for the settings tab. Never persisted. */
	licenseError: string | undefined = undefined;

	private saveTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.refreshLicense();

		this.signals = new SignalStore(this.app, this.manifest.id, this.settings.signalsWriterId, {
			...timingOptions(this.settings),
		});
		await this.signals.init();

		this.tracker = new EffortTracker({
			plugin: this,
			store: this.signals,
			timing: () => timingOptions(this.settings),
			excludeFolders: () => this.settings.excludeFolders,
		});
		this.tracker.start();

		// Refcounts this add-on onto the shared host. No process, no download, no network — a
		// download happens only from EngineInstallModal's confirm handler, and the child spawns
		// only when a Pro user actually asks for an analysis.
		this.engine = EngineBroker.acquire(this.app, this.manifest.id, {
			enginePath: this.settings.enginePath || undefined,
		});
		this.engineIndex = new EffortEngineIndex(this.app, () => this.engine);
		this.analyst = new EffortAnalyst(this);

		// The engine's copy of a note is content-addressed, so a rename moves no vectors and a
		// delete must drop them. Both are cheap no-ops when there is no engine.
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "md") void this.engineIndex.remove([file.path]);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "md") void this.engineIndex.rename(oldPath, file.path);
			})
		);

		this.registerView(VIEW_TYPE_EFFORT, (leaf) => new EffortView(leaf, this));
		registerCommands(this);
		this.addSettingTab(new EffortIndexSettingTab(this));

		// The engine's state lives on disk. Read it once, after load, so the settings tab and the
		// view can render it synchronously — and so a Pro user is told "not installed" rather than
		// being shown an empty report.
		this.app.workspace.onLayoutReady(() => {
			void this.refreshEngineStatus();
		});
	}

	/**
	 * Synchronous, because Obsidian's `onunload` is. The order matters:
	 *
	 *   1. close the tracker — a burst in progress is real work, and closing it EMITS the
	 *      `edit`/`dwell` events into the store's buffer;
	 *   2. flush the buffer to disk (fire-and-forget: there is no awaiting here, but issuing
	 *      the write beats dropping it);
	 *   3. dispose the store, which stops its debounce timer and marks it dead so the broker
	 *      can see the writer slot has gone stale;
	 *   4. release the writer slot, so a surviving Second Read plugin re-elects on its next
	 *      event instead of silently logging nothing.
	 *
	 * Do NOT detachLeavesOfType() — the obsidianmd `detach-leaves` rule forbids it, and it
	 * would close the user's sidebar pane on every plugin update.
	 */
	onunload(): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
			void this.saveData(this.settings);
		}
		this.tracker?.close();
		void this.signals?.flush();
		this.signals?.dispose();
		SignalsBroker.releaseIfOwner(this.manifest.id);

		// Stop whatever the engine is doing FOR US (a scan is one query per note, and it would keep
		// running inside the sidecar), then drop our ref. The child is killed only when the LAST
		// Second Read add-on releases — killing it here would break Prior Art mid-keystroke.
		this.analyst?.cancel();
		EngineBroker.release(this.manifest.id);
	}

	// --- settings -------------------------------------------------------------

	async loadSettings(): Promise<void> {
		// EVERY field is coerced back to its declared type: data.json is a file on disk that a
		// hand edit, a sync merge or an older build can leave in any shape at all, and a
		// `licenseKey` that came back as a number used to crash `onload()` outright.
		this.settings = coerceSettings(await this.loadData());

		// The shard id is minted once and then never changes: it names this install's file in
		// the shared log, and a new id would orphan every event already written.
		if (this.settings.signalsWriterId === "") {
			this.settings.signalsWriterId = newWriterId();
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await this.saveData(this.settings);

		// ALWAYS with this add-on's id. The host is SHARED and keeps one bucket of engine settings
		// per add-on, so that five settings tabs cannot fight over a single global `enginePath`;
		// omitting the id lands ours in the anonymous bucket, where clearing our own path could
		// never take effect and would silently keep steering the engine for everyone else.
		this.engine?.updateSettings({ enginePath: this.settings.enginePath || undefined }, this.manifest.id);

		this.refreshViews();
	}

	/** Coalesced save, for controls that fire continuously (sliders, the license field). */
	queueSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveSettings();
		}, SAVE_DEBOUNCE_MS);
	}

	/** Flush a queued save immediately — the settings tab calls this when it closes. */
	async flushPendingSave(): Promise<void> {
		if (this.saveTimer === null) return;
		await this.saveSettings();
	}

	/**
	 * Re-verify the stored key and apply the resulting entitlement.
	 *
	 * @param persistUnchanged save even when nothing moved (so a key being typed survives a restart)
	 * @param coalesce queue the save instead of writing immediately
	 * @returns true when Pro actually flipped — the caller re-renders on that, and only that
	 */
	async refreshLicense(persistUnchanged = false, coalesce = false): Promise<boolean> {
		const key = this.settings.licenseKey.trim();
		const verified = key ? LicenseManager.verify(key) : null;
		const transition = resolveLicenseTransition(
			{ isPro: this.settings.isPro, email: this.settings.licenseEmail },
			key,
			verified,
			persistUnchanged
		);
		this.settings.isPro = transition.isPro;
		this.settings.licenseEmail = transition.email;
		this.licenseError = key && !transition.isPro ? (verified?.error ?? "Invalid license key.") : undefined;
		if (transition.persist) {
			// A Pro flip is a real state change and must land now; a keystroke in the key field
			// that changed nothing else can wait.
			if (coalesce && !transition.flipped) this.queueSave();
			else await this.saveSettings();
		}
		return transition.flipped;
	}

	// --- read surface ---------------------------------------------------------

	/** Every note's aggregates, merged across every shard in the shared log. */
	async readSignals(): Promise<SignalsIndex> {
		return this.signals.readIndex();
	}

	/** Paths of the notes that still exist — so the view never shows a ghost row. */
	livePaths(): Set<string> {
		return new Set(this.app.vault.getMarkdownFiles().map((file) => file.path));
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_EFFORT)[0];
		const leaf: WorkspaceLeaf | null = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE_EFFORT, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_EFFORT)) {
			const view = leaf.view;
			if (view instanceof EffortView) void view.render();
		}
	}

	/** The "Clear activity log" button and command. Erases every shard, not just ours. */
	async clearActivityLog(): Promise<void> {
		await this.signals.clear();
		this.refreshViews();
	}

	// --- the semantic engine (Pro) ---------------------------------------------

	/**
	 * True when a semantic Pro feature can actually RUN right now: Pro, a desktop engine client,
	 * and an engine that is installed (or a BYO path).
	 *
	 * The commands gate on Pro + a non-null client, NOT on this — a Pro user with no engine must
	 * still be able to reach the feature, because that is where the install offer lives. Hiding it
	 * would leave them with a paid feature they cannot even find the "on" switch for.
	 */
	canRunSemanticPro(): boolean {
		if (!this.settings.isPro || !this.engine) return false;
		const state = this.engineStatus?.state;
		return state === "installed" || state === "running";
	}

	/** True when the Pro features are even reachable on this machine (desktop + an engine client). */
	engineAvailable(): boolean {
		return this.engine !== null;
	}

	async refreshEngineStatus(): Promise<EngineStatus | null> {
		if (!this.engine) {
			this.engineStatus = null;
			return null;
		}
		this.engineStatus = await this.engine.status();
		return this.engineStatus;
	}

	/** The settings "Test engine" button. Starts what is installed; downloads nothing, ever. */
	async testEngine(): Promise<EngineStatus> {
		if (!this.engine) {
			return {
				state: "unsupported",
				expectedVersion: "",
				installed: null,
				updateAvailable: false,
				byoPath: false,
				health: null,
				error: "The semantic engine runs on desktop only.",
			};
		}
		try {
			await this.engine.ensureStarted();
		} catch (error) {
			console.error("effort-index: the engine probe failed", error);
		}
		const status = await this.refreshEngineStatus();
		return status ?? (await this.engine.status());
	}

	/** The user just installed (or updated) the engine. Everything we believed about it is void. */
	async onEngineInstalled(): Promise<void> {
		this.engineIndex.reset();
		this.analyst.reset();
		await this.refreshEngineStatus();
		this.refreshViews();
	}

	/**
	 * Remove the engine binary. The index is deliberately KEPT (DESIGN 7.3 step 9).
	 *
	 * `EngineHost.remove()` disposes the child WITHOUT latching the host dead, precisely so that
	 * this add-on removing the engine does not poison it for Prior Art and Standing Questions,
	 * which are holding the same object.
	 */
	async removeEngine(): Promise<void> {
		if (!this.engine) return;
		this.analyst.cancel();
		await this.engine.remove();
		this.engineIndex.reset();
		this.analyst.reset();
		await this.refreshEngineStatus();
		this.refreshViews();
	}

	/** The settings "Rebuild index" button. Re-walks the vault into the shared `notes` namespace. */
	async rebuildEngineIndex(onProgress: (done: number, total: number) => void): Promise<number> {
		if (!this.canRunSemanticPro()) {
			throw new Error("The semantic engine is not available. Nothing to rebuild.");
		}
		this.engineIndex.reset();
		this.analyst.reset();
		const result = await this.engineIndex.indexVault(onProgress);
		return result.done;
	}
}
