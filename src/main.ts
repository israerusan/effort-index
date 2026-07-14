import { Plugin, type WorkspaceLeaf } from "obsidian";
import { resolveLicenseTransition } from "./shared/licenseTransition.mjs";
import { SignalStore, newWriterId } from "./shared/signals/SignalStore";
import { SignalsBroker } from "./shared/signals/SignalsBroker";
import type { SignalsIndex } from "./shared/signals/signalsAggregate.d.mts";
import { LicenseManager } from "./license/LicenseManager";
import { EffortTracker } from "./signals/EffortTracker";
import { DEFAULT_SETTINGS, timingOptions, type EffortIndexSettings } from "./settings";
import { EffortIndexSettingTab } from "./ui/SettingsTab";
import { EffortView, VIEW_TYPE_EFFORT } from "./ui/EffortView";
import { registerCommands } from "./commands";

/** How long a burst of continuous setting changes is coalesced before a write. */
const SAVE_DEBOUNCE_MS = 400;

export default class EffortIndexPlugin extends Plugin {
	settings: EffortIndexSettings = { ...DEFAULT_SETTINGS };
	signals!: SignalStore;
	tracker!: EffortTracker;

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

		this.registerView(VIEW_TYPE_EFFORT, (leaf) => new EffortView(leaf, this));
		registerCommands(this);
		this.addSettingTab(new EffortIndexSettingTab(this));
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
	}

	// --- settings -------------------------------------------------------------

	async loadSettings(): Promise<void> {
		const loaded: unknown = await this.loadData();
		const data = (loaded ?? {}) as Record<string, unknown>;
		// A hostile or corrupt data.json must not reach the prototype chain and forge `isPro`
		// onto every object in the runtime.
		if (Object.prototype.hasOwnProperty.call(data, "__proto__")) delete data["__proto__"];

		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.excludeFolders = coerceStringArray(this.settings.excludeFolders);
		this.settings.isPro = this.settings.isPro === true;

		// The shard id is minted once and then never changes: it names this install's file in
		// the shared log, and a new id would orphan every event already written.
		if (typeof this.settings.signalsWriterId !== "string" || this.settings.signalsWriterId === "") {
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
}

function coerceStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}
