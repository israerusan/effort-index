import { TFile, type App } from "obsidian";
import type { EffortIndexSettings } from "./settings";
import type { EngineHost, EngineStatus } from "./shared/engine/EngineHost";
import type { SignalsIndex } from "./shared/signals/signalsAggregate.d.mts";
import type { EffortEngineIndex } from "./effortEngine";
import { FEATURES } from "./core/features.mjs";
import { isFeatureEnabled } from "./shared/featureGates.mjs";
import { selectExpensiveNotes } from "./core/expensive.mjs";
import type { ExpensiveRow } from "./core/expensive.d.mts";
import { ORPHAN_PROBE_K, selectOrphans } from "./core/orphaned.mjs";
import type { OrphanRow, ReuseProbe } from "./core/orphaned.d.mts";
import { clusterByTopic } from "./core/clusters.mjs";
import type { TopicCluster, TopicEdge } from "./core/clusters.d.mts";

/**
 * THE TWO PRO FEATURES, AND — MORE IMPORTANTLY — WHAT THEY DO WHEN THEY CANNOT RUN.
 *
 * A semantic feature has four ways to be unavailable (not Pro, not desktop, no engine
 * installed, engine broken) and one way to find nothing. All five of them produce an empty
 * list. If the UI just renders that list, all five of them read as "we looked, and your vault
 * is fine" — which is a lie in four cases out of five, and the specific lie that makes a paid
 * feature feel like it does nothing. That is the failure this file exists to prevent:
 *
 *   EVERY report carries a `state` and a `message`. An empty `rows` is only ever a FINDING when
 *   `state === "ok"`, and even then the message says how many notes were actually looked at.
 *
 * `offerInstall` is the one actionable degradation: Pro, desktop, no engine. The view turns it
 * into a button that opens the shared consent modal — nothing is downloaded without a click.
 */

export type AnalysisState =
	/** The analysis ran. `rows`/`clusters` are the answer, and may legitimately be empty. */
	| "ok"
	/** Free tier. The feature is gated, not broken. */
	| "not-pro"
	/** Mobile, an unsupported platform, or an incompatible engine client in the realm. */
	| "unsupported"
	/** Desktop + Pro, but no engine on disk. The one state with a next step. */
	| "not-installed"
	/** The engine is there and it failed. The message is the engine's own. */
	| "engine-error"
	/** There is no measured effort to analyse yet. Nothing to do with the engine. */
	| "no-data"
	/** Superseded by a newer run, or the user stopped it. NOT a result. */
	| "cancelled";

export interface AnalysisReport {
	state: AnalysisState;
	/** Always a full sentence. The view renders this verbatim, in every state including "ok". */
	message: string;
	/** True only when the honest next step is "install the engine". */
	offerInstall: boolean;
	/** Notes the engine actually answered for. */
	analysed: number;
	/** Notes it could not answer for. Never silently folded into a finding. */
	skipped: number;
	/** Expensive notes the scan was pointed at. */
	candidates: number;
}

export interface OrphanReport extends AnalysisReport {
	rows: OrphanRow[];
}

export interface ClusterReport extends AnalysisReport {
	clusters: TopicCluster[];
	ungrouped: ExpensiveRow[];
}

export interface AnalysisProgress {
	phase: "indexing" | "scanning";
	done: number;
	total: number;
}

/**
 * What the analyst needs from the plugin. An interface, not the plugin class, so the whole Pro
 * layer can be driven in a test against a fake engine with no Obsidian and no vault.
 */
export interface AnalysisContext {
	app: App;
	settings: EffortIndexSettings;
	/** Null on mobile / unsupported / incompatible client. NEVER constructed here — the broker owns it. */
	engine: EngineHost | null;
	engineIndex: EffortEngineIndex;
	engineStatus: EngineStatus | null;
	refreshEngineStatus(): Promise<EngineStatus | null>;
	readSignals(): Promise<SignalsIndex>;
	livePaths(): Set<string>;
}

/**
 * How many neighbours to ask for when clustering. The engine ranks against the WHOLE vault, and
 * we then keep only the hits that are themselves expensive notes — so k has to be generous
 * enough that a candidate's siblings are not pushed off the end by unrelated notes that happen
 * to be similar. 25 is a compromise, and a deliberate one: the alternative (an `exclude` list
 * naming every non-candidate note in the vault) would be a several-thousand-element array on
 * every query.
 */
const CLUSTER_K = 25;

export class EffortAnalyst {
	/**
	 * Bumped by every run. A run whose generation is stale drops its result on the floor rather
	 * than racing a newer one into the view — and, before it starts, it CANCELS the older run's
	 * in-flight engine requests (`cancelInflight` -> the `cancel` RPC, DESIGN 6.2 method 8), so
	 * the sidecar stops computing an answer nobody is waiting for. An orphan scan is one query
	 * per expensive note; a superseded one left running is the expensive kind of waste.
	 */
	private generation = 0;
	/** The vault only needs walking into the index once per session (and after a reinstall). */
	private vaultIndexed = false;

	constructor(private readonly ctx: AnalysisContext) {}

	/** The engine was installed, removed, or rebuilt. Whatever we believed about it is void. */
	reset(): void {
		this.vaultIndexed = false;
		this.generation += 1;
		this.ctx.engineIndex.cancelInflight();
	}

	/** Supersede whatever is running. Called on unload and when the view switches away. */
	cancel(): void {
		this.generation += 1;
		this.ctx.engineIndex.cancelInflight();
	}

	/* ------------------------------------------------------------ preflight */

	/**
	 * Everything that can stop a semantic feature before a single note is read, in the order the
	 * user would ask about it. Returns null when the engine is genuinely usable.
	 */
	private async blocker(featureKey: string): Promise<AnalysisReport | null> {
		const { settings, engine } = this.ctx;

		if (!isFeatureEnabled(FEATURES, featureKey, settings.isPro)) {
			return this.blocked("not-pro", `${FEATURES[featureKey].label} is a Pro feature.`);
		}

		if (!engine) {
			return this.blocked(
				"unsupported",
				"The semantic engine runs on desktop only. Everything else in this add-on — the measurement, " +
					"the expensive-notes list, and the CSV export — works here."
			);
		}

		const status = this.ctx.engineStatus ?? (await this.ctx.refreshEngineStatus());
		if (!status || status.state === "unsupported") {
			return this.blocked(
				"unsupported",
				engine.planError() ?? "No engine build is available for this computer."
			);
		}

		if (status.state === "not-installed") {
			return this.blocked(
				"not-installed",
				`${FEATURES[featureKey].label} compares your notes by MEANING, which needs the local semantic ` +
					"engine — a self-contained program that runs on your computer and sends nothing over the " +
					"network. It is not installed, so this analysis cannot run and has not been guessed at.",
				true
			);
		}

		return null;
	}

	private blocked(state: AnalysisState, message: string, offerInstall = false): AnalysisReport {
		return { state, message, offerInstall, analysed: 0, skipped: 0, candidates: 0 };
	}

	/**
	 * Walk the whole vault into the engine's `notes` namespace, once.
	 *
	 * THIS IS NOT OPTIONAL AND IT IS NOT AN OPTIMISATION. Orphan detection asks "what else in the
	 * vault resembles this note?", and against an EMPTY index the answer for every note is
	 * "nothing" — so a plugin that skipped this step would confidently report the user's entire
	 * vault as orphaned investment. The most damaging possible false positive, produced by doing
	 * nothing at all.
	 *
	 * It is cheap on the second run and cheap for a user who also has Prior Art: the sidecar skips
	 * any chunk whose key it already holds, and the chunker is shared and byte-identical.
	 */
	private async indexVault(
		generation: number,
		onProgress?: (progress: AnalysisProgress) => void
	): Promise<{ ok: boolean; stopped: boolean; message?: string }> {
		if (this.vaultIndexed) return { ok: true, stopped: false };
		try {
			const result = await this.ctx.engineIndex.indexVault(
				(done, total) => onProgress?.({ phase: "indexing", done, total }),
				() => generation !== this.generation
			);
			if (result.stopped) return { ok: false, stopped: true };
			this.vaultIndexed = true;
			return { ok: true, stopped: false };
		} catch (error) {
			return {
				ok: false,
				stopped: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** The expensive notes a scan is pointed at. */
	private async candidates(staleDays: number): Promise<ExpensiveRow[]> {
		const index = await this.ctx.readSignals();
		return selectExpensiveNotes(index, {
			now: Date.now(),
			staleDays,
			excludeFolders: this.ctx.settings.excludeFolders,
			livePaths: this.ctx.livePaths(),
			limit: this.ctx.settings.scanLimit,
		});
	}

	private file(path: string): TFile | null {
		const file = this.ctx.app.vault.getFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	/* -------------------------------------------------- orphaned investment */

	/**
	 * "Expensive notes whose ideas were never reused" (DESIGN 4.4).
	 *
	 * Deliberately NOT filtered by coldness. The expensive-notes VIEW asks "what did I stop
	 * reading?"; this asks "what never went anywhere?", and a note you re-read every week whose
	 * ideas never propagated into anything else is exactly the kind of sunk cost worth seeing.
	 */
	async orphans(onProgress?: (progress: AnalysisProgress) => void): Promise<OrphanReport> {
		const generation = ++this.generation;
		this.ctx.engineIndex.cancelInflight();

		const blocked = await this.blocker("orphanedInvestment");
		if (blocked) return { ...blocked, rows: [] };

		// staleDays: -1 disables the coldness filter — the same selector the CSV export uses,
		// rather than a second one that could drift from it.
		const rows = await this.candidates(-1);
		if (generation !== this.generation) return this.supersededOrphans();
		if (rows.length === 0) {
			return {
				...this.blocked(
					"no-data",
					"No note has any measured editing time yet, so there is nothing to call orphaned. Effort " +
						"Index measures as you work — come back once it has watched you for a while."
				),
				rows: [],
			};
		}

		const indexed = await this.indexVault(generation, onProgress);
		if (generation !== this.generation) return this.supersededOrphans();
		if (indexed.stopped) return this.supersededOrphans();
		if (!indexed.ok) {
			return {
				...this.blocked(
					"engine-error",
					`The vault could not be indexed, so nothing was analysed: ${indexed.message ?? "the engine failed."}`
				),
				rows: [],
			};
		}

		const probes: Record<string, ReuseProbe> = Object.create(null) as Record<string, ReuseProbe>;
		let done = 0;
		let engineFailures = 0;
		for (const row of rows) {
			if (generation !== this.generation) return this.supersededOrphans();
			onProgress?.({ phase: "scanning", done, total: rows.length });
			done += 1;

			const file = this.file(row.path);
			if (!file) continue; // deleted under us; livePaths said otherwise a moment ago

			const result = await this.ctx.engineIndex.probeReuse(file, ORPHAN_PROBE_K);
			if (!result.ok) {
				if (result.reason === "engine") engineFailures += 1;
				continue; // NOT a probe of zero. Unprobed notes are `skipped`, never reported.
			}
			probes[row.path] = {
				// The engine answered and found nothing: a real similarity of zero, and a real finding.
				bestScore: result.best ? result.best.score : 0,
				bestNote: result.best?.note ?? "",
				bestPreview: result.best?.preview ?? "",
				bestHeading: result.best?.heading ?? "",
			};
		}
		if (generation !== this.generation) return this.supersededOrphans();

		const selection = selectOrphans(rows, probes, {
			orphanMaxScore: this.ctx.settings.orphanMaxScore,
		});

		// Nothing was probed successfully — that is an engine failure, not a clean bill of health.
		if (selection.analysed === 0) {
			return {
				...this.blocked(
					"engine-error",
					`The engine could not analyse any of the ${String(rows.length)} expensive notes. ` +
						`${this.ctx.engineIndex.error ?? "It may have stopped."} Nothing has been reported either way.`
				),
				rows: [],
			};
		}

		return {
			state: "ok",
			offerInstall: false,
			analysed: selection.analysed,
			skipped: selection.skipped,
			candidates: rows.length,
			rows: selection.rows,
			message: describeOrphanOutcome(selection.rows.length, selection.analysed, selection.skipped, engineFailures),
		};
	}

	private supersededOrphans(): OrphanReport {
		return { ...this.blocked("cancelled", "The analysis was superseded by a newer one."), rows: [] };
	}

	/* ---------------------------------------------------- topic clustering */

	/** "Group the effort report by topic" (DESIGN 4.4) — the same list the view shows, grouped. */
	async clusters(onProgress?: (progress: AnalysisProgress) => void): Promise<ClusterReport> {
		const generation = ++this.generation;
		this.ctx.engineIndex.cancelInflight();

		const blocked = await this.blocker("effortClusters");
		if (blocked) return { ...blocked, clusters: [], ungrouped: [] };

		// The expensive-notes LIST, grouped — so the coldness filter is the view's, not none.
		const rows = await this.candidates(this.ctx.settings.staleDays);
		if (generation !== this.generation) return this.supersededClusters();
		if (rows.length === 0) {
			return {
				...this.blocked(
					"no-data",
					`No note has both measured editing time and ${String(this.ctx.settings.staleDays)} days of silence yet, ` +
						"so there is nothing to group."
				),
				clusters: [],
				ungrouped: [],
			};
		}

		const indexed = await this.indexVault(generation, onProgress);
		if (generation !== this.generation) return this.supersededClusters();
		if (indexed.stopped) return this.supersededClusters();
		if (!indexed.ok) {
			return {
				...this.blocked(
					"engine-error",
					`The vault could not be indexed, so nothing was grouped: ${indexed.message ?? "the engine failed."}`
				),
				clusters: [],
				ungrouped: [],
			};
		}

		const candidatePaths = new Set(rows.map((row) => row.path));
		const edges: TopicEdge[] = [];
		let analysed = 0;
		let skipped = 0;
		let done = 0;

		for (const row of rows) {
			if (generation !== this.generation) return this.supersededClusters();
			onProgress?.({ phase: "scanning", done, total: rows.length });
			done += 1;

			const file = this.file(row.path);
			if (!file) {
				skipped += 1;
				continue;
			}

			const hits = await this.ctx.engineIndex.neighbours(file, {
				k: CLUSTER_K,
				minScore: this.ctx.settings.clusterMinScore,
				exclude: [row.path],
			});
			if (hits === undefined) {
				skipped += 1; // the engine did not answer. Not "this note has no topic".
				continue;
			}
			analysed += 1;
			for (const hit of hits) {
				// Only edges BETWEEN expensive notes: we are grouping the effort report, not the vault.
				if (!candidatePaths.has(hit.note)) continue;
				edges.push({ from: row.path, to: hit.note, score: hit.score });
			}
		}
		if (generation !== this.generation) return this.supersededClusters();

		if (analysed === 0) {
			return {
				...this.blocked(
					"engine-error",
					`The engine could not analyse any of the ${String(rows.length)} expensive notes. ` +
						`${this.ctx.engineIndex.error ?? "It may have stopped."} Nothing has been grouped.`
				),
				clusters: [],
				ungrouped: [],
			};
		}

		const grouping = clusterByTopic(rows, edges, { minScore: this.ctx.settings.clusterMinScore });

		return {
			state: "ok",
			offerInstall: false,
			analysed,
			skipped,
			candidates: rows.length,
			clusters: grouping.clusters,
			ungrouped: grouping.ungrouped,
			message: describeClusterOutcome(grouping.clusters.length, grouping.grouped, analysed, skipped),
		};
	}

	private supersededClusters(): ClusterReport {
		return {
			...this.blocked("cancelled", "The analysis was superseded by a newer one."),
			clusters: [],
			ungrouped: [],
		};
	}
}

/**
 * The sentence a SUCCESSFUL orphan scan prints — including, and especially, the one that found
 * nothing. "No orphaned investment" is a real result and deserves to be said out loud; a blank
 * panel says the same thing about a feature that crashed.
 */
export function describeOrphanOutcome(
	found: number,
	analysed: number,
	skipped: number,
	engineFailures: number
): string {
	const scope = `Analysed ${String(analysed)} expensive note${analysed === 1 ? "" : "s"}`;
	const missed =
		skipped > 0
			? ` ${String(skipped)} could not be analysed${engineFailures > 0 ? " (the engine failed on them)" : " (no indexable text)"} and are not reported either way.`
			: "";

	if (found === 0) {
		return `${scope}. Every one of them has a close relative elsewhere in your vault — none of that work is orphaned.${missed}`;
	}
	return `${scope}. ${String(found)} of them ${found === 1 ? "has" : "have"} no counterpart anywhere else in your vault: the time went in, and the ideas never came out.${missed}`;
}

export function describeClusterOutcome(
	clusters: number,
	grouped: number,
	analysed: number,
	skipped: number
): string {
	const missed = skipped > 0 ? ` ${String(skipped)} note${skipped === 1 ? "" : "s"} could not be analysed.` : "";
	if (clusters === 0) {
		return `Analysed ${String(analysed)} expensive note${analysed === 1 ? "" : "s"}. None of them are close enough to each other to form a topic — your expensive work is spread across unrelated subjects.${missed}`;
	}
	return `Analysed ${String(analysed)} expensive note${analysed === 1 ? "" : "s"} into ${String(clusters)} topic${clusters === 1 ? "" : "s"} covering ${String(grouped)} of them.${missed}`;
}
