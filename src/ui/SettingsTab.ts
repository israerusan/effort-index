import { PluginSettingTab, Setting } from "obsidian";
import type EffortIndexPlugin from "../main";
import { createExternalLink } from "./links";
import { ConfirmModal } from "./ConfirmModal";
import { FEATURES } from "../core/features.mjs";
import { proFeatureKeys } from "../shared/featureGates.mjs";
import {
	PRO_NAME,
	PRO_PRICE_LABEL,
	PRO_TAGLINE,
	PRO_UNLOCK_SUMMARY,
	PURCHASE_URL,
	SUITE_NAME,
} from "../product";

export class EffortIndexSettingTab extends PluginSettingTab {
	constructor(private plugin: EffortIndexPlugin) {
		super(plugin.app, plugin);
	}

	/** Nothing typed into a coalesced control may be lost when the tab closes. */
	hide(): void {
		void this.plugin.flushPendingSave();
	}

	display(): void {
		this.containerEl.empty();
		this.renderLicense();
		this.renderMeasurement();
		this.renderReport();
		this.renderPrivacy();
	}

	// --- License (DESIGN 4.5) ----------------------------------------------------

	private renderLicense(): void {
		new Setting(this.containerEl).setName("License").setHeading();

		new Setting(this.containerEl)
			.setName("License key")
			.setDesc("Verified offline — no account, no server, no network request.")
			.addTextArea((text) => {
				text.inputEl.rows = 3;
				text.inputEl.addClass("effort-index-license-input");
				text
					.setPlaceholder("Paste your Second Read key")
					.setValue(this.plugin.settings.licenseKey)
					.onChange((value) => {
						this.plugin.settings.licenseKey = value;
						// Re-verify per keystroke (offline, microseconds) but only rebuild the tab when
						// Pro actually flips — display() empties containerEl, which would destroy the
						// textarea the user is typing into.
						void this.plugin.refreshLicense(true, true).then((flipped) => {
							if (flipped) this.display();
						});
					});
			});

		const status = this.containerEl.createDiv({ cls: "effort-index-license-status" });
		if (this.plugin.settings.isPro) {
			status.addClass("is-pro");
			const email = this.plugin.settings.licenseEmail;
			status.createEl("p", {
				text:
					`Pro active${email ? ` — ${email}` : ""}. This key also unlocks Note Decay, ` +
					"Standing Questions, Prior Art, and Unwritten.",
			});
			return;
		}

		if (this.plugin.licenseError) {
			status.createEl("p", { cls: "effort-index-license-error", text: this.plugin.licenseError });
		} else {
			status.createEl("p", {
				text: `Free tier. Pro unlocks ${PRO_UNLOCK_SUMMARY} — and the same key unlocks Pro in all five ${SUITE_NAME} add-ons.`,
			});
		}

		this.renderProCard();
	}

	/**
	 * The upgrade card. createDiv/createEl/createSpan only — NEVER innerHTML.
	 *
	 * The title is a styled DIV, not an <h4>: `settings-tab/no-manual-html-headings` bans raw
	 * heading elements in a settings tab (headings must come from `Setting.setHeading()`), and a
	 * Setting row is the wrong shape for a card.
	 */
	private renderProCard(): void {
		const card = this.containerEl.createDiv({ cls: "effort-index-pro-card" });
		card.createDiv({ cls: "effort-index-pro-title", text: `${PRO_NAME} — ${PRO_PRICE_LABEL}` });
		card.createEl("p", { cls: "effort-index-pro-tagline", text: PRO_TAGLINE });

		const list = card.createEl("ul", { cls: "effort-index-pro-list" });
		for (const key of proFeatureKeys(FEATURES)) {
			list.createEl("li", { text: FEATURES[key].label });
		}

		// An anchor, not window.open — Obsidian routes it to the OS on desktop and mobile.
		createExternalLink(card, { cls: "effort-index-pro-btn", text: "Unlock Pro", url: PURCHASE_URL });
	}

	// --- Measurement --------------------------------------------------------------

	private renderMeasurement(): void {
		new Setting(this.containerEl).setName("Measurement").setHeading();

		new Setting(this.containerEl)
			.setName("Idle cutoff")
			.setDesc(
				"Seconds of silence that end an editing session. The idle time itself is never counted — " +
					"a note left open on screen earns nothing."
			)
			.addSlider((slider) =>
				slider
					.setLimits(15, 300, 5)
					.setValue(this.plugin.settings.idleCutoffSeconds)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.idleCutoffSeconds = value;
						this.plugin.queueSave();
					})
			);

		new Setting(this.containerEl)
			.setName("Minimum session")
			.setDesc("Seconds. Editing bursts shorter than this are discarded as noise.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 1)
					.setValue(this.plugin.settings.minSessionSeconds)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.minSessionSeconds = value;
						this.plugin.queueSave();
					})
			);

		new Setting(this.containerEl)
			.setName("Revision gap")
			.setDesc("Minutes. Editing sessions further apart than this count as separate revisions.")
			.addSlider((slider) =>
				slider
					.setLimits(5, 240, 5)
					.setValue(this.plugin.settings.revisionGapMinutes)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.revisionGapMinutes = value;
						this.plugin.queueSave();
					})
			);

		new Setting(this.containerEl)
			.setName("Dwell cap")
			.setDesc("Minutes. The most a single visit to a note can add to its dwell time.")
			.addSlider((slider) =>
				slider
					.setLimits(5, 120, 5)
					.setValue(this.plugin.settings.dwellCapMinutes)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.dwellCapMinutes = value;
						this.plugin.queueSave();
					})
			);

		new Setting(this.containerEl)
			.setName("Excluded folders")
			.setDesc("One per line. Notes in these folders are neither measured nor reported.")
			.addTextArea((text) => {
				text.inputEl.rows = 3;
				text
					.setPlaceholder("Templates\nArchive")
					.setValue(this.plugin.settings.excludeFolders.join("\n"))
					.onChange((value) => {
						this.plugin.settings.excludeFolders = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line !== "");
						this.plugin.queueSave();
					});
			});
	}

	// --- Report -------------------------------------------------------------------

	private renderReport(): void {
		new Setting(this.containerEl).setName("Report").setHeading();

		new Setting(this.containerEl)
			.setName("Consider a note cold after")
			.setDesc("Days without being opened, before it can appear in the expensive-notes list.")
			.addSlider((slider) =>
				slider
					.setLimits(7, 365, 1)
					.setValue(this.plugin.settings.staleDays)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.staleDays = value;
						this.plugin.queueSave();
					})
			);

		new Setting(this.containerEl)
			.setName("Expensive notes")
			.setDesc("Open the list in the sidebar.")
			.addButton((button) =>
				button.setButtonText("Open").onClick(() => {
					void this.plugin.activateView();
				})
			);
	}

	// --- Activity log (the privacy disclosure lives HERE, where the data does) --------

	private renderPrivacy(): void {
		new Setting(this.containerEl).setName("Activity log").setHeading();

		new Setting(this.containerEl)
			.setName("Retention")
			.setDesc("Days. Aggregates for notes untouched for longer than this are dropped.")
			.addSlider((slider) =>
				slider
					.setLimits(30, 1095, 30)
					.setValue(this.plugin.settings.retentionDays)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.retentionDays = value;
						this.plugin.queueSave();
					})
			);

		new Setting(this.containerEl)
			.setName("Clear the activity log")
			.setDesc(
				"Erases every recorded open, edit, and dwell — on this device, permanently. " +
					"The log never leaves your machine, and this cannot be undone."
			)
			.addButton((button) =>
				button
					.setButtonText("Clear")
					.setWarning()
					.onClick(() => {
						new ConfirmModal(this.app, {
							title: "Clear the activity log?",
							body: "Every recorded open, edit, and dwell is deleted. Months of measurement cannot be reconstructed. This cannot be undone.",
							cta: "Clear the log",
							onConfirm: () => {
								void this.plugin.clearActivityLog();
							},
						}).open();
					})
			);
	}
}
