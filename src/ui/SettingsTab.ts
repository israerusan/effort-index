import { Notice, PluginSettingTab, Setting } from "obsidian";
import type EffortIndexPlugin from "../main";
import { createExternalLink } from "./links";
import { ConfirmModal } from "./ConfirmModal";
import { EngineLogModal } from "./EngineLogModal";
import { FEATURES } from "../core/features.mjs";
import { proFeatureKeys } from "../shared/featureGates.mjs";
import { ENGINE_RELEASE_PINNED, ENGINE_VERSION } from "../shared/engine/engineRelease.mjs";
import { MAX_SCAN_LIMIT, MIN_SCAN_LIMIT } from "../settings";
import {
	DOWNLOAD_SIZE_LABEL,
	canInstallEngine,
	engineInstallBlockedReason,
	offerEngineInstall,
} from "./engineInstall";
import {
	CHECKOUT_OPEN,
	PRO_NAME,
	PRO_PRICE_LABEL,
	PRO_TAGLINE,
	PRO_UNLOCK_SUMMARY,
	PURCHASE_PENDING_COPY,
	PURCHASE_URL,
	SUITE_NAME,
} from "../product";

/** The only place bug reports and feature requests are tracked. */
const ISSUES_URL = "https://github.com/israerusan/effort-index/issues";

export class EffortIndexSettingTab extends PluginSettingTab {
	/** The in-settings progress row (DESIGN 7.2). Rebuilt with the engine box. */
	private progressEl: HTMLElement | null = null;
	/** Guard: display() kicks one async status read, and that read re-displays exactly once. */
	private statusRequested = false;

	constructor(private plugin: EffortIndexPlugin) {
		super(plugin.app, plugin);
	}

	/** Nothing typed into a coalesced control may be lost when the tab closes. */
	hide(): void {
		void this.plugin.flushPendingSave();
	}

	display(): void {
		this.containerEl.empty();
		this.progressEl = null;

		this.renderLicense();
		this.renderMeasurement();
		this.renderReport();
		this.renderPro();
		this.renderEngine();
		this.renderPrivacy();
		this.renderFeedback();

		// The engine's state lives on disk, so reading it is async and display() is not. Ask once,
		// then re-render — never in a loop.
		if (this.plugin.engine && !this.plugin.engineStatus && !this.statusRequested) {
			this.statusRequested = true;
			void this.plugin.refreshEngineStatus().then(() => {
				this.display();
			});
		}
	}

	// --- gating primitives -------------------------------------------------------

	private markPro(setting: Setting): void {
		setting.nameEl.createSpan({ cls: "effort-index-pro-pill", text: "Pro" });
	}

	/**
	 * A Pro row for a free user shows a disabled lock and says what it would do — never an empty
	 * right-hand side, which reads as a rendering bug rather than as a paywall. It does NOT show
	 * a purchase button while the till is closed; the Pro card in the License section carries the
	 * one honest statement about that, and repeating a dead CTA five times is five lies.
	 */
	private proRow(name: string, desc: string, render: (setting: Setting) => void): void {
		const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
		this.markPro(setting);
		if (!this.plugin.settings.isPro) {
			setting.settingEl.addClass("effort-index-setting-locked");
			setting.addExtraButton((button) => button.setIcon("lock").setDisabled(true).setTooltip("Pro feature"));
			return;
		}
		render(setting);
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
	 * The Pro card. createDiv/createEl/createSpan only — NEVER innerHTML.
	 *
	 * THE BUTTON IS CONDITIONAL, AND THAT IS THE POINT. v1.0.0 shipped a live "$29 — Unlock Pro"
	 * anchor to a generic BuyMeACoffee handle page, for two features that did not exist and an
	 * `isPro` flag that gated nothing: a buyer would have paid, waited for a hand-emailed key,
	 * pasted it, seen "Pro active", and observed no change whatsoever. The features are now built
	 * — but the checkout still is not, so the card names what Pro does and says plainly that
	 * there is nothing to buy yet. A CTA appears the moment `PURCHASE_URL` is a real one, and not
	 * a keystroke before (see product.ts — it is one edit).
	 *
	 * The title is a styled DIV, not an <h4>: `settings-tab/no-manual-html-headings` bans raw
	 * heading elements in a settings tab, and a Setting row is the wrong shape for a card.
	 */
	private renderProCard(): void {
		const card = this.containerEl.createDiv({ cls: "effort-index-pro-card" });
		card.createDiv({ cls: "effort-index-pro-title", text: `${PRO_NAME} — ${PRO_PRICE_LABEL}` });
		card.createEl("p", { cls: "effort-index-pro-tagline", text: PRO_TAGLINE });

		const list = card.createEl("ul", { cls: "effort-index-pro-list" });
		for (const key of proFeatureKeys(FEATURES)) {
			list.createEl("li", { text: FEATURES[key].label });
		}

		if (CHECKOUT_OPEN && PURCHASE_URL) {
			// An anchor, not window.open — Obsidian routes it to the OS on desktop and mobile.
			createExternalLink(card, { cls: "effort-index-pro-btn", text: "Unlock Pro", url: PURCHASE_URL });
			return;
		}

		card.createEl("p", { cls: "effort-index-pro-pending", text: PURCHASE_PENDING_COPY });
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

	// --- Pro features -----------------------------------------------------------------

	private renderPro(): void {
		const heading = new Setting(this.containerEl).setName("Pro features").setHeading();
		this.markPro(heading);

		this.containerEl.createEl("p", {
			cls: "effort-index-hint",
			text:
				"Both compare notes by MEANING, not by keyword, so both need the local semantic engine " +
				"below. Neither one sends anything over the network, and neither runs until you ask it to. " +
				"They live in the “Orphaned” and “By topic” tabs of the expensive-notes panel.",
		});

		this.proRow(
			FEATURES.orphanedInvestment.label,
			"A note is orphaned when its closest counterpart anywhere else in your vault is below this " +
				"similarity: the hours went in and the ideas never came out. 0.45 is where a sentence " +
				"embedding stops calling two passages related at all — raise it to be told about more notes, " +
				"lower it to be told only about the truly isolated ones.",
			(setting) => {
				setting.addSlider((slider) =>
					slider
						.setLimits(0.2, 0.8, 0.01)
						.setValue(this.plugin.settings.orphanMaxScore)
						.setDynamicTooltip()
						.onChange((value) => {
							this.plugin.settings.orphanMaxScore = value;
							this.plugin.queueSave();
						})
				);
			}
		);

		this.proRow(
			FEATURES.effortClusters.label,
			"How close two expensive notes must be to land in the same topic. Below about 0.5, notes that " +
				"merely share a vocabulary start grouping, and every topic becomes “everything”.",
			(setting) => {
				setting.addSlider((slider) =>
					slider
						.setLimits(0.4, 0.9, 0.01)
						.setValue(this.plugin.settings.clusterMinScore)
						.setDynamicTooltip()
						.onChange((value) => {
							this.plugin.settings.clusterMinScore = value;
							this.plugin.queueSave();
						})
				);
			}
		);

		this.proRow(
			"Notes per scan",
			"How many of your most expensive notes a semantic scan looks at. Each one is a round trip to " +
				"the engine, so this is the difference between a report and a coffee break. The report always " +
				"says how many it actually analysed.",
			(setting) => {
				setting.addSlider((slider) =>
					slider
						.setLimits(MIN_SCAN_LIMIT, MAX_SCAN_LIMIT, 5)
						.setValue(this.plugin.settings.scanLimit)
						.setDynamicTooltip()
						.onChange((value) => {
							this.plugin.settings.scanLimit = value;
							this.plugin.queueSave();
						})
				);
			}
		);
	}

	// --- Semantic engine (DESIGN 7.2) -------------------------------------------------

	private renderEngine(): void {
		new Setting(this.containerEl).setName("Semantic engine").setHeading();

		const host = this.plugin.engine;
		const box = this.containerEl.createDiv({ cls: "effort-index-engine" });

		if (!host || !host.desktop) {
			box.createEl("p", {
				text:
					"The semantic engine runs on desktop only. Everything else in this add-on — the " +
					"measurement, the expensive-notes list, and the CSV export — works here.",
			});
			return;
		}

		box.createEl("p", {
			text:
				"The Pro features need a local engine: a self-contained program that runs on your computer, " +
				`reads only the text this add-on sends it, and opens no network connections. It is ${DOWNLOAD_SIZE_LABEL}, ` +
				"and it installs outside your vault, in your system's application-data folder.",
		});

		this.progressEl = box.createDiv({ cls: "effort-index-engine-progress" });

		const status = this.plugin.engineStatus;
		const installed = status?.installed ?? null;
		const byo = status?.byoPath ?? false;

		if (installed || byo) this.renderInstalledEngine(box, byo);
		else this.renderDownloadRow(box);

		// The fallback path, and the honest answer to "is the download the mechanism?". It is not:
		// it is a convenience, and this setting is what makes that true. It is also the fix for
		// every Defender quarantine, noexec mount, Flatpak confinement and hostile Gatekeeper.
		new Setting(box)
			.setName("Path to an existing engine")
			.setDesc("Absolute path to an engine binary you already have. When this is set, nothing is ever downloaded.")
			.addText((text) =>
				text
					.setPlaceholder("/path/to/embed-sidecar")
					.setValue(this.plugin.settings.enginePath)
					.onChange((value) => {
						this.plugin.settings.enginePath = value.trim();
						this.plugin.queueSave();
					})
			);

		new Setting(box)
			.setName("Test engine")
			.setDesc("Starts the engine that is already installed and asks it for its version. Nothing is downloaded.")
			.addButton((button) =>
				button.setButtonText("Test engine").onClick(async () => {
					button.setDisabled(true);
					try {
						const result = await this.plugin.testEngine();
						new Notice(
							result.health
								? `Engine ready — ${result.health.model}, ${String(result.health.dim)}-dim.`
								: `Engine ${result.state}. ${result.error ?? "No engine is installed."}`
						);
					} finally {
						button.setDisabled(false);
						this.display();
					}
				})
			);

		new Setting(box)
			.setName("Engine log")
			.setDesc("The last 200 lines the engine wrote to its error stream.")
			.addButton((button) =>
				button.setButtonText("Engine log").onClick(() => {
					new EngineLogModal(this.app, host.engineLog()).open();
				})
			);
	}

	/** "Not installed": one button, and it opens the consent modal. It does NOT download. */
	private renderDownloadRow(box: HTMLElement): void {
		const blocked = engineInstallBlockedReason(this.plugin);
		const setting = new Setting(box)
			.setName("Download engine")
			.setDesc(
				blocked ??
					`Downloads engine ${ENGINE_VERSION}, verifies its SHA-256, and runs it. You will be shown the exact ` +
						"URL, version, checksum and install path before anything is downloaded."
			);

		setting.addButton((button) => {
			button.setButtonText("Download engine").setCta();
			// A build whose checksum is still the unpinned placeholder REFUSES to download — there
			// would be nothing to verify the bytes against, and downloading an unverified executable
			// is the single thing this whole design exists to prevent. An enabled button that always
			// fails would be worse than the truth.
			if (!canInstallEngine(this.plugin)) {
				button.setDisabled(true);
				if (!ENGINE_RELEASE_PINNED) button.setTooltip("Not available in this release.");
				return;
			}
			button.onClick(() => {
				offerEngineInstall(this.plugin, {
					onProgress: (line) => this.progressEl?.setText(line),
					onDone: () => {
						this.display();
					},
				});
			});
		});
	}

	/** "Installed": what is there, and everything you can do to it — including remove it. */
	private renderInstalledEngine(box: HTMLElement, byo: boolean): void {
		const status = this.plugin.engineStatus;
		const installed = status?.installed ?? null;

		const info = new Setting(box).setName("Installed engine");
		if (byo) {
			info.setDesc(
				`Using the engine you pointed at: ${this.plugin.settings.enginePath}. Nothing was downloaded, and nothing will be.`
			);
		} else if (installed) {
			info.setDesc(`Version ${installed.version} · ${installed.target} · installed at ${installed.exePath}`);
		}

		if (status?.updateAvailable && !byo) {
			// NEVER a silent update. Obsidian policy bans "a mechanism that updates the plugin", and a
			// binary that re-downloads itself is arguably exactly that. We detect, and we offer.
			new Setting(box)
				.setName("Update engine")
				.setDesc(
					`This add-on expects engine ${ENGINE_VERSION}; ${installed?.version ?? "an older version"} is installed. ` +
						"Nothing updates on its own — you will see the URL, checksum and path first."
				)
				.addButton((button) =>
					button
						.setButtonText("Update engine")
						.setCta()
						.setDisabled(!canInstallEngine(this.plugin))
						.onClick(() => {
							offerEngineInstall(this.plugin, {
								onProgress: (line) => this.progressEl?.setText(line),
								onDone: () => {
									this.display();
								},
							});
						})
				);
		}

		new Setting(box)
			.setName("Rebuild the note index")
			.setDesc(
				"Re-embeds every note so the semantic reports have something to compare against. The engine " +
					"skips text it already holds, so this is fast the second time — and it is shared with the " +
					"other Second Read add-ons rather than duplicated."
			)
			.addButton((button) =>
				button.setButtonText("Rebuild index").onClick(async () => {
					button.setDisabled(true);
					try {
						const count = await this.plugin.rebuildEngineIndex((done, total) => {
							this.progressEl?.setText(`Indexing… ${String(done)} / ${String(total)}`);
						});
						new Notice(`Indexed ${String(count)} note${count === 1 ? "" : "s"}.`);
					} catch (error) {
						new Notice(error instanceof Error ? error.message : "Could not rebuild the index.");
					} finally {
						button.setDisabled(false);
						this.progressEl?.setText("");
					}
				})
			);

		new Setting(box)
			.setName("Remove engine")
			.setDesc("Stops the engine and deletes the program. Your notes and the index are kept.")
			.addButton((button) =>
				button
					.setButtonText("Remove engine")
					.setWarning()
					.setDisabled(byo)
					.onClick(async () => {
						button.setDisabled(true);
						try {
							await this.plugin.removeEngine();
							new Notice("The engine was removed. The index was kept.");
						} catch (error) {
							new Notice(error instanceof Error ? error.message : "Could not remove the engine.");
						} finally {
							this.display();
						}
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

	// --- Feedback -----------------------------------------------------------------

	/** Bug reports and feature requests go to the issue tracker, and nowhere else. */
	private renderFeedback(): void {
		new Setting(this.containerEl).setName("Feedback").setHeading();

		const row = new Setting(this.containerEl)
			.setName("Bugs and feature requests")
			.setDesc("Issues and ideas are tracked on GitHub. Opens in your browser.");

		// Anchors, not window.open — links.ts is the house rule for outbound links because
		// Obsidian routes an anchor to the OS browser on desktop AND on mobile.
		const links = row.controlEl.createDiv({ cls: "effort-index-feedback-links" });
		createExternalLink(links, {
			text: "Report a bug",
			url: `${ISSUES_URL}/new?labels=bug`,
		});
		createExternalLink(links, {
			text: "Request a feature",
			url: `${ISSUES_URL}/new?labels=enhancement`,
		});
	}
}
