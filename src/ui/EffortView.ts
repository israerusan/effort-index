import { ItemView, type WorkspaceLeaf } from "obsidian";
import type EffortIndexPlugin from "../main";
import { formatColdness, formatDuration, selectExpensiveNotes } from "../core/expensive.mjs";
import type { ExpensiveRow } from "../core/expensive.d.mts";
import { describeOrphan } from "../core/orphaned.mjs";
import type { AnalysisProgress, ClusterReport, OrphanReport } from "../effortAnalysis";
import { FEATURES } from "../core/features.mjs";
import { isFeatureEnabled } from "../shared/featureGates.mjs";
import { canInstallEngine, engineInstallBlockedReason, offerEngineInstall } from "./engineInstall";
import { createExternalLink } from "./links";
import {
	CHECKOUT_OPEN,
	PRO_NAME,
	PRO_PRICE_LABEL,
	PRO_UPSELL,
	PURCHASE_PENDING_COPY,
	PURCHASE_URL,
} from "../product";

export const VIEW_TYPE_EFFORT = "effort-index-expensive";

/** The three things this panel can show. Two of them are Pro. */
export type EffortMode = "all" | "topics" | "orphans";

const MODES: Array<{ mode: EffortMode; label: string; feature: string | null }> = [
	{ mode: "all", label: "All", feature: null },
	{ mode: "topics", label: "By topic", feature: "effortClusters" },
	{ mode: "orphans", label: "Orphaned", feature: "orphanedInvestment" },
];

/**
 * "The most expensive notes you stopped opening" — and, for Pro, the two semantic reports.
 *
 * THE RULE THIS FILE IS BUILT AROUND: an empty list is only ever rendered when the analysis
 * actually RAN and actually found nothing. Every other outcome — free tier, mobile, no engine
 * installed, engine crashed, no measured effort yet — renders the reason in words, and (where
 * one exists) the next step. A Pro feature that silently shows an empty panel is a Pro feature
 * that appears not to work, and this add-on used to charge $29 for exactly that.
 *
 * All markup is createEl/createDiv — never innerHTML — and every pixel of styling is a class in
 * styles.css; nothing here assigns `el.style.x`.
 */
export class EffortView extends ItemView {
	private readonly plugin: EffortIndexPlugin;
	/** Bumped on every render; a late async result from an earlier render is discarded. */
	private generation = 0;
	private mode: EffortMode = "all";
	/** The last report for each Pro mode, so switching back does not re-run the engine. */
	private orphanReport: OrphanReport | null = null;
	private clusterReport: ClusterReport | null = null;
	private running = false;
	private progressLine = "";
	/** The live progress line, held rather than re-queried: the panel is rebuilt on every render. */
	private progressEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: EffortIndexPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_EFFORT;
	}

	getDisplayText(): string {
		return "Expensive notes";
	}

	getIcon(): string {
		return "hourglass";
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	async onClose(): Promise<void> {
		// A scan is one engine query per note. Closing the panel it was feeding must stop it.
		this.plugin.analyst?.cancel();
	}

	/** The command entry points. Switches mode and runs the analysis. */
	async show(mode: EffortMode): Promise<void> {
		this.mode = mode;
		await this.render();
		if (mode !== "all") await this.runAnalysis(mode);
	}

	async render(): Promise<void> {
		const generation = ++this.generation;
		const index = await this.plugin.readSignals();
		// The user switched away, or a newer render started while we were reading the log.
		if (generation !== this.generation) return;

		const settings = this.plugin.settings;
		const rows = selectExpensiveNotes(index, {
			now: Date.now(),
			staleDays: settings.staleDays,
			excludeFolders: settings.excludeFolders,
			livePaths: this.plugin.livePaths(),
		});

		// Entitlement can flip under a running view — a key was pasted, or removed, or a data.json
		// was hand-edited. A free user must never be left looking at a Pro REPORT… but they must
		// still be able to open the locked tab and read what it would do, so what gets dropped here
		// is the cached result, not the mode. (`renderProMode` gates on the feature table before it
		// touches either report, so a stale one can never be rendered to a free user.)
		if (!this.plugin.settings.isPro) {
			this.orphanReport = null;
			this.clusterReport = null;
		}

		const root = this.contentEl;
		root.empty();
		root.addClass("effort-index-view");
		this.progressEl = null; // the old one just went out with root.empty()

		const header = root.createDiv({ cls: "effort-index-header" });
		header.createEl("h3", { text: "Most expensive notes" });
		header.createEl("p", {
			cls: "effort-index-subtitle",
			text: `Notes you put real editing time into and have not opened in ${String(settings.staleDays)} days.`,
		});

		this.renderModeBar(root);

		if (this.mode === "all") {
			this.renderAllMode(root, rows);
			return;
		}
		this.renderProMode(root);
	}

	/* --------------------------------------------------------------- mode bar */

	private renderModeBar(root: HTMLElement): void {
		const bar = root.createDiv({ cls: "effort-index-modes" });
		for (const entry of MODES) {
			const locked =
				entry.feature !== null &&
				!isFeatureEnabled(FEATURES, entry.feature, this.plugin.settings.isPro);

			const button = bar.createEl("button", {
				cls: "effort-index-mode",
				text: entry.label,
			});
			if (this.mode === entry.mode) button.addClass("is-active");
			if (locked) {
				button.addClass("is-locked");
				button.createSpan({ cls: "effort-index-mode-lock", text: "Pro" });
			}

			this.registerDomEvent(button, "click", () => {
				this.mode = entry.mode;
				void this.render().then(() => {
					// A locked mode renders the Pro explainer instead of running anything: no engine is
					// started, nothing is downloaded, and no empty list is passed off as a result.
					if (!locked && entry.mode !== "all") void this.runAnalysis(entry.mode);
				});
			});
		}
	}

	/* ------------------------------------------------------------- free modes */

	private renderAllMode(root: HTMLElement, rows: ExpensiveRow[]): void {
		if (rows.length === 0) {
			root.createEl("p", {
				cls: "effort-index-empty",
				text: "Nothing yet. Effort Index measures editing time as you work — come back once it has watched you for a while.",
			});
			return;
		}
		const list = root.createDiv({ cls: "effort-index-list" });
		for (const row of rows) this.renderRow(list, row);
	}

	private renderRow(list: HTMLElement, row: ExpensiveRow, note?: string): void {
		const item = list.createDiv({ cls: "effort-index-row" });
		item.createDiv({ cls: "effort-index-title", text: basename(row.path) });

		const meta = item.createDiv({ cls: "effort-index-meta" });
		meta.createSpan({ cls: "effort-index-time", text: formatDuration(row.editMs) });
		meta.createSpan({
			cls: "effort-index-revisions",
			text: `${String(row.revisions)} ${row.revisions === 1 ? "revision" : "revisions"}`,
		});
		meta.createSpan({ cls: "effort-index-coldness", text: formatColdness(row.daysSinceOpen) });

		item.createDiv({ cls: "effort-index-path", text: row.path });
		if (note) item.createDiv({ cls: "effort-index-note", text: note });

		// The row is the affordance. `openLinkText` respects the user's "open in new tab"
		// preferences, which a manual `getLeaf().openFile()` would quietly override.
		this.registerDomEvent(item, "click", () => {
			void this.plugin.app.workspace.openLinkText(row.path, "", false);
		});
	}

	/* -------------------------------------------------------------- Pro modes */

	private renderProMode(root: HTMLElement): void {
		const feature = this.mode === "orphans" ? "orphanedInvestment" : "effortClusters";

		if (!isFeatureEnabled(FEATURES, feature, this.plugin.settings.isPro)) {
			this.renderProPitch(root, feature);
			return;
		}

		if (this.running) {
			this.progressEl = root.createEl("p", {
				cls: "effort-index-progress",
				text: this.progressLine || "Working…",
			});
			return;
		}

		const report = this.mode === "orphans" ? this.orphanReport : this.clusterReport;
		if (!report) {
			// The analysis has not been kicked yet (a fresh render of a Pro mode). runAnalysis()
			// follows immediately; saying "Analysing" is the truth, and an empty list would not be.
			this.progressEl = root.createEl("p", { cls: "effort-index-progress", text: "Analysing…" });
			return;
		}

		// EVERY state prints its sentence — including "ok". An empty report is never a bare blank.
		const explain = root.createDiv({ cls: "effort-index-explain" });
		explain.createEl("p", { text: report.message });

		if (report.offerInstall) {
			this.renderInstallOffer(explain);
			return;
		}
		if (report.state !== "ok") {
			if (report.state === "engine-error") this.renderRetry(explain);
			return;
		}

		const rerun = root.createEl("button", { cls: "effort-index-rerun", text: "Run again" });
		this.registerDomEvent(rerun, "click", () => {
			void this.runAnalysis(this.mode);
		});

		if (this.mode === "orphans") this.renderOrphans(root, report as OrphanReport);
		else this.renderClusters(root, report as ClusterReport);
	}

	private renderOrphans(root: HTMLElement, report: OrphanReport): void {
		if (report.rows.length === 0) return; // the message above already said what happened
		const list = root.createDiv({ cls: "effort-index-list" });
		for (const row of report.rows) this.renderRow(list, row, describeOrphan(row));
	}

	private renderClusters(root: HTMLElement, report: ClusterReport): void {
		for (const cluster of report.clusters) {
			const group = root.createDiv({ cls: "effort-index-cluster" });
			const head = group.createDiv({ cls: "effort-index-cluster-head" });
			head.createSpan({ cls: "effort-index-cluster-label", text: cluster.label });
			head.createSpan({
				cls: "effort-index-cluster-total",
				text: `${formatDuration(cluster.editMs)} · ${String(cluster.size)} notes`,
			});
			const list = group.createDiv({ cls: "effort-index-list" });
			for (const row of cluster.notes) this.renderRow(list, row);
		}

		if (report.ungrouped.length > 0) {
			const group = root.createDiv({ cls: "effort-index-cluster" });
			const head = group.createDiv({ cls: "effort-index-cluster-head" });
			head.createSpan({ cls: "effort-index-cluster-label", text: "On their own" });
			head.createSpan({
				cls: "effort-index-cluster-total",
				text: `${String(report.ungrouped.length)} notes`,
			});
			const list = group.createDiv({ cls: "effort-index-list" });
			for (const row of report.ungrouped) this.renderRow(list, row);
		}
	}

	/**
	 * A Pro user, on a desktop, with no engine. THE one degradation with a next step — and the
	 * offer is a button that opens the shared consent modal. Nothing downloads without that click.
	 */
	private renderInstallOffer(parent: HTMLElement): void {
		const blocked = engineInstallBlockedReason(this.plugin);
		if (!canInstallEngine(this.plugin)) {
			parent.createEl("p", {
				cls: "effort-index-degraded",
				text: blocked ?? "No engine build is available for this computer.",
			});
			return;
		}
		parent.createEl("p", {
			cls: "effort-index-degraded",
			text:
				"You will be shown the exact URL, version, SHA-256 and install path before anything is " +
				"downloaded, and the checksum is verified before anything is run.",
		});
		const button = parent.createEl("button", {
			cls: "effort-index-install mod-cta",
			text: "Install the engine",
		});
		this.registerDomEvent(button, "click", () => {
			offerEngineInstall(this.plugin, {
				onDone: () => {
					void this.render();
				},
			});
		});
	}

	private renderRetry(parent: HTMLElement): void {
		const button = parent.createEl("button", { cls: "effort-index-rerun", text: "Try again" });
		this.registerDomEvent(button, "click", () => {
			void this.runAnalysis(this.mode);
		});
	}

	/**
	 * The free tier's view of a Pro feature: what it does, what it costs, and — while the till is
	 * closed — that there is nothing to buy yet. No dead "Unlock Pro" button pointing at a generic
	 * tip-jar page; that is what the last build shipped, for features that did not exist.
	 */
	private renderProPitch(root: HTMLElement, feature: string): void {
		const card = root.createDiv({ cls: "effort-index-pro-card" });
		card.createDiv({ cls: "effort-index-pro-title", text: FEATURES[feature].label });
		card.createEl("p", { cls: "effort-index-pro-tagline", text: PRO_UPSELL[feature] ?? "" });

		if (CHECKOUT_OPEN && PURCHASE_URL) {
			card.createEl("p", {
				cls: "effort-index-pro-tagline",
				text: `${PRO_NAME} — ${PRO_PRICE_LABEL}.`,
			});
			createExternalLink(card, { cls: "effort-index-pro-btn", text: "Unlock Pro", url: PURCHASE_URL });
			return;
		}

		card.createEl("p", { cls: "effort-index-pro-pending", text: PURCHASE_PENDING_COPY });
	}

	/* ------------------------------------------------------------- the runner */

	/**
	 * Run one analysis. A second call SUPERSEDES the first: `EffortAnalyst` bumps its generation
	 * and cancels the older run's in-flight engine requests, so the sidecar stops computing an
	 * answer nobody is waiting for.
	 */
	async runAnalysis(mode: EffortMode): Promise<void> {
		if (mode === "all") return;
		if (!this.plugin.settings.isPro) return;

		this.running = true;
		this.progressLine = "Analysing…";
		const generation = ++this.generation;
		const onProgress = (progress: AnalysisProgress): void => {
			this.progressLine =
				progress.phase === "indexing"
					? `Indexing your vault for the first time… ${String(progress.done)} / ${String(progress.total)}`
					: `Analysing… ${String(progress.done)} / ${String(progress.total)}`;
			if (generation === this.generation) this.paintProgress();
		};

		try {
			if (mode === "orphans") this.orphanReport = await this.plugin.analyst.orphans(onProgress);
			else this.clusterReport = await this.plugin.analyst.clusters(onProgress);
		} catch (error) {
			console.error("effort-index: the analysis failed", error);
		} finally {
			this.running = false;
		}

		// A newer run (or a mode switch) started while we were working. Its render owns the panel.
		if (generation !== this.generation) return;
		await this.render();
	}

	/**
	 * Repaint just the progress line. Deliberately NOT a re-render: an orphan scan emits a
	 * progress event per note, and rebuilding the whole panel forty times would fight the user
	 * for the scroll position and re-read the signals log on every tick.
	 */
	private paintProgress(): void {
		this.progressEl?.setText(this.progressLine);
	}
}

function basename(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return name.endsWith(".md") ? name.slice(0, -3) : name;
}
