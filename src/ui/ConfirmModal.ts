import { Modal, Setting, type App } from "obsidian";

/**
 * A yes/no gate for the one destructive thing this add-on can do: erase the activity log.
 * The log is months of measurement that cannot be reconstructed, so it never goes away on a
 * single misclick.
 *
 * Built with createEl/createSpan only — never innerHTML (the `no-inner-html` review rule),
 * and no `el.style.x` assignment (all styling is in styles.css).
 */
export class ConfirmModal extends Modal {
	private readonly title: string;
	private readonly body: string;
	private readonly cta: string;
	private readonly onConfirm: () => void;

	constructor(app: App, options: { title: string; body: string; cta: string; onConfirm: () => void }) {
		super(app);
		this.title = options.title;
		this.body = options.body;
		this.cta = options.cta;
		this.onConfirm = options.onConfirm;
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { cls: "effort-index-confirm-body", text: this.body });

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.cta)
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
