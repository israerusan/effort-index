import { MarkdownView, Notice, normalizePath } from "obsidian";
import type EffortIndexPlugin from "./main";
import { ConfirmModal } from "./ui/ConfirmModal";
import { EffortView, VIEW_TYPE_EFFORT, type EffortMode } from "./ui/EffortView";
import { FEATURES } from "./core/features.mjs";
import { isFeatureEnabled } from "./shared/featureGates.mjs";
import {
	formatColdness,
	formatDuration,
	selectExpensiveNotes,
	toCsv,
} from "./core/expensive.mjs";

/**
 * Command ids are kebab-case and the titles are sentence case with NO plugin name in them
 * (Obsidian prefixes the plugin name itself — "Effort Index: Effort Index: …" is a review
 * finding). Nothing binds a default hotkey.
 *
 * A command that cannot do anything right now uses `checkCallback` and returns false, which
 * HIDES it from the palette. Registering a command that fires an error Notice is worse than
 * not offering it.
 */
export function registerCommands(plugin: EffortIndexPlugin): void {
	plugin.addCommand({
		id: "open-effort-view",
		name: "Show expensive notes",
		callback: () => {
			void plugin.activateView();
		},
	});

	plugin.addCommand({
		id: "show-effort-for-note",
		name: "Show effort for this note",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
			if (!file || file.extension !== "md") return false;
			if (checking) return true;
			void showEffortFor(plugin, file.path);
			return true;
		},
	});

	plugin.addCommand({
		id: "export-effort-csv",
		name: "Export effort data as CSV",
		callback: () => {
			void exportCsv(plugin);
		},
	});

	plugin.addCommand({
		id: "clear-activity-log",
		name: "Clear the activity log",
		callback: () => {
			new ConfirmModal(plugin.app, {
				title: "Clear the activity log?",
				body: "Every recorded open, edit, and dwell is deleted. Months of measurement cannot be reconstructed. This cannot be undone.",
				cta: "Clear the log",
				onConfirm: () => {
					void plugin.clearActivityLog().then(() => new Notice("Activity log cleared."));
				},
			}).open();
		},
	});

	// --- Pro (semantic) ---------------------------------------------------------------
	//
	// Gated on Pro AND on an engine CLIENT being available (desktop) — but deliberately NOT on
	// the engine being INSTALLED. A Pro user with no engine yet must be able to reach the
	// feature, because reaching it is what shows them the install offer; hiding the command
	// would leave them holding a key for a feature they cannot find the "on" switch for.
	//
	// A free user sees neither command: a palette entry whose only behaviour is to open a sales
	// pitch is an entry that should not be in the palette. The Pro surface they CAN see is the
	// locked tab in the view and the card in settings, both of which explain themselves.

	plugin.addCommand({
		id: "find-orphaned-investment",
		name: "Find expensive notes nobody reused",
		checkCallback: (checking) => {
			if (!isFeatureEnabled(FEATURES, "orphanedInvestment", plugin.settings.isPro)) return false;
			if (!plugin.engineAvailable()) return false;
			if (checking) return true;
			void openMode(plugin, "orphans");
			return true;
		},
	});

	plugin.addCommand({
		id: "group-effort-by-topic",
		name: "Group the effort report by topic",
		checkCallback: (checking) => {
			if (!isFeatureEnabled(FEATURES, "effortClusters", plugin.settings.isPro)) return false;
			if (!plugin.engineAvailable()) return false;
			if (checking) return true;
			void openMode(plugin, "topics");
			return true;
		},
	});
}

/** Open the panel and put it into a Pro mode. The view owns the degradation copy from there. */
async function openMode(plugin: EffortIndexPlugin, mode: EffortMode): Promise<void> {
	await plugin.activateView();
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_EFFORT)) {
		const view = leaf.view;
		if (view instanceof EffortView) await view.show(mode);
	}
}

/** The one-note answer: what has this note actually cost, including the burst in progress. */
async function showEffortFor(plugin: EffortIndexPlugin, path: string): Promise<void> {
	const index = await plugin.readSignals();
	const signals = index[path];
	const pending = plugin.tracker.pendingFor(path);
	if (!signals && pending.editMs === 0) {
		new Notice("No recorded effort for this note yet.");
		return;
	}
	const editMs = (signals?.editMs ?? 0) + pending.editMs;
	const revisions = signals?.revisions ?? 0;
	const rows = selectExpensiveNotes({ [path]: signals ?? {} }, { now: Date.now(), staleDays: -1 });
	const coldness = rows.length > 0 ? formatColdness(rows[0].daysSinceOpen) : "Never opened";
	new Notice(
		`${formatDuration(editMs)} of editing · ${revisions} ${revisions === 1 ? "revision" : "revisions"} · last opened ${coldness.toLowerCase()}`
	);
}

/**
 * Every note the log knows about, as CSV, written into the vault. `staleDays: -1` disables
 * the coldness filter, so this is the same selector the view uses rather than a second one
 * that could drift from it.
 */
async function exportCsv(plugin: EffortIndexPlugin): Promise<void> {
	const index = await plugin.readSignals();
	const rows = selectExpensiveNotes(index, {
		now: Date.now(),
		staleDays: -1,
		excludeFolders: plugin.settings.excludeFolders,
		livePaths: plugin.livePaths(),
	});
	if (rows.length === 0) {
		new Notice("No effort data to export yet.");
		return;
	}

	const path = await uniquePath(plugin, `Effort Index ${stamp()}`);
	try {
		await plugin.app.vault.create(path, toCsv(rows));
		new Notice(`Exported ${rows.length} notes to ${path}`);
	} catch (error) {
		console.error("effort-index: CSV export failed", error);
		new Notice("Could not write the CSV export. Check that the vault is writable.");
	}
}

/** `Effort Index 2026-07-14.csv`, then ` 2`, ` 3`… — an export never clobbers an earlier one. */
async function uniquePath(plugin: EffortIndexPlugin, base: string): Promise<string> {
	const adapter = plugin.app.vault.adapter;
	for (let n = 1; n < 100; n++) {
		const candidate = normalizePath(`${base}${n === 1 ? "" : ` ${n}`}.csv`);
		if (!(await adapter.exists(candidate))) return candidate;
	}
	return normalizePath(`${base} ${Date.now()}.csv`);
}

function stamp(): string {
	const now = new Date();
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
