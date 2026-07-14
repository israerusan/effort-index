import { ItemView, type WorkspaceLeaf } from "obsidian";
import type EffortIndexPlugin from "../main";
import {
	formatColdness,
	formatDuration,
	selectExpensiveNotes,
} from "../core/expensive.mjs";
import type { ExpensiveRow } from "../core/expensive.d.mts";

export const VIEW_TYPE_EFFORT = "effort-index-expensive";

/**
 * "The most expensive notes you stopped opening."
 *
 * The whole point of the plugin in one list: notes that absorbed real, measured, idle-trimmed
 * editing time and that you then stopped reading. Ranked by editing time, filtered to notes
 * gone cold for longer than `staleDays`.
 *
 * All markup is createEl/createDiv — never innerHTML (the review bot rejects it) — and every
 * pixel of styling is a class in styles.css; nothing here assigns `el.style.x`.
 */
export class EffortView extends ItemView {
	private readonly plugin: EffortIndexPlugin;
	/** Bumped on every render; a late async result from an earlier render is discarded. */
	private generation = 0;

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

		const root = this.contentEl;
		root.empty();
		root.addClass("effort-index-view");

		const header = root.createDiv({ cls: "effort-index-header" });
		header.createEl("h3", { text: "Most expensive notes" });
		header.createEl("p", {
			cls: "effort-index-subtitle",
			text: `Notes you put real editing time into and have not opened in ${settings.staleDays} days.`,
		});

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

	private renderRow(list: HTMLElement, row: ExpensiveRow): void {
		const item = list.createDiv({ cls: "effort-index-row" });
		item.createDiv({ cls: "effort-index-title", text: basename(row.path) });

		const meta = item.createDiv({ cls: "effort-index-meta" });
		meta.createSpan({ cls: "effort-index-time", text: formatDuration(row.editMs) });
		meta.createSpan({
			cls: "effort-index-revisions",
			text: `${row.revisions} ${row.revisions === 1 ? "revision" : "revisions"}`,
		});
		meta.createSpan({ cls: "effort-index-coldness", text: formatColdness(row.daysSinceOpen) });

		item.createDiv({ cls: "effort-index-path", text: row.path });

		// The row is the affordance. `openLinkText` respects the user's "open in new tab"
		// preferences, which a manual `getLeaf().openFile()` would quietly override.
		this.registerDomEvent(item, "click", () => {
			void this.plugin.app.workspace.openLinkText(row.path, "", false);
		});
	}
}

function basename(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return name.endsWith(".md") ? name.slice(0, -3) : name;
}
