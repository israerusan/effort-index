import { Notice } from "obsidian";
import type EffortIndexPlugin from "../main";
import { EngineInstallModal } from "../shared/engine/EngineInstallModal";
import { ENGINE_RELEASE_PINNED, ENGINE_VERSION } from "../shared/engine/engineRelease.mjs";
import type { InstallProgress } from "../shared/engine/EngineHost";
import { engineInstallDir } from "../core/enginePaths.mjs";
import { nodeHostInfo } from "../nodeHost";

/**
 * THE CONSENT GATE, in one place.
 *
 * `EngineHost.install()` has exactly one caller in this add-on and it is the confirm handler
 * below. Nothing is fetched, unpacked, made executable or run until the user has seen the URL,
 * the version, the SHA-256, and the directory it lands in — and has clicked "Download and run".
 *
 * Two surfaces offer the install (the settings tab, and the Pro panel in the view when a Pro
 * user has no engine). They both come through here, so there is exactly ONE code path that can
 * start a download, and it is the one with the modal in front of it.
 */

/** What the install actually costs. Measured, not guessed — an understated number is a lie. */
export const DOWNLOAD_SIZE_LABEL = "about 50 MB (about 105 MB once unpacked)";

/** True when this build could actually download an engine for this machine. */
export function canInstallEngine(plugin: EffortIndexPlugin): boolean {
	const host = plugin.engine;
	if (!host || !host.desktop) return false;
	// A build whose checksum is still the unpinned placeholder REFUSES to download: there would be
	// nothing to verify the bytes against, and downloading an unverified executable is the single
	// thing this whole design exists to prevent.
	return ENGINE_RELEASE_PINNED && host.plan() !== null;
}

/** Why it cannot, in a sentence a settings tab or a panel can print. Null when it can. */
export function engineInstallBlockedReason(plugin: EffortIndexPlugin): string | null {
	const host = plugin.engine;
	if (!host || !host.desktop) {
		return "The semantic engine runs on desktop only. Everything else in this add-on works here.";
	}
	if (!ENGINE_RELEASE_PINNED || host.plan() === null) {
		return (
			host.planError() ??
			"No engine build is published for this release yet, so there is nothing to download and verify. " +
				"The Pro features stay off until there is; everything else in this add-on works now."
		);
	}
	return null;
}

/**
 * Open the consent modal, and — only if the user confirms — run the install.
 *
 * `onDone` fires after a successful install, so the caller can re-render. A FAILURE is surfaced
 * verbatim: the messages EngineHost produces are the specific ones (a failed checksum, a blocked
 * exec bit, a quarantined binary), and a generic "install failed" is what turns a solvable
 * Defender problem into a one-star review.
 */
export function offerEngineInstall(
	plugin: EffortIndexPlugin,
	options: { onProgress?: (line: string) => void; onDone?: () => void } = {}
): void {
	const host = plugin.engine;
	if (!host) {
		new Notice("The semantic engine runs on desktop only.");
		return;
	}

	const plan = host.plan();
	if (!plan || !ENGINE_RELEASE_PINNED) {
		new Notice(engineInstallBlockedReason(plugin) ?? "No engine build is available for this computer.");
		return;
	}

	const info = nodeHostInfo();
	if (!info) {
		new Notice("The semantic engine runs on desktop only.");
		return;
	}

	new EngineInstallModal(plugin.app, {
		plan,
		installDir: engineInstallDir(info, plan.version),
		downloadSizeLabel: DOWNLOAD_SIZE_LABEL,
		onConfirm: () => {
			void runInstall(plugin, options);
		},
	}).open();
}

async function runInstall(
	plugin: EffortIndexPlugin,
	options: { onProgress?: (line: string) => void; onDone?: () => void }
): Promise<void> {
	const host = plugin.engine;
	if (!host) return;

	const notice = new Notice("Downloading engine…", 0);
	try {
		const health = await host.install((progress) => {
			const line = describeProgress(progress);
			notice.setMessage(line);
			options.onProgress?.(line);
		});
		notice.hide();
		new Notice(`Engine ready — ${health.model}, ${String(health.dim)}-dim.`);
		await plugin.onEngineInstalled();
		options.onDone?.();
	} catch (error) {
		notice.hide();
		new Notice(error instanceof Error ? error.message : "The engine could not be installed.", 12_000);
		options.onDone?.();
	}
}

/** `Downloading engine… 18.4 MB / 44.7 MB` (DESIGN 7.2). */
export function describeProgress(progress: InstallProgress): string {
	switch (progress.phase) {
		case "downloading": {
			const done = megabytes(progress.done ?? 0);
			const total = progress.total ? ` / ${megabytes(progress.total)}` : "";
			return `Downloading engine… ${done}${total}`;
		}
		case "verifying":
			return "Verifying the checksum…";
		case "extracting":
			return "Extracting…";
		case "starting":
			return "Starting…";
		case "ready":
			return progress.message ?? "Engine ready.";
		default:
			return "Working…";
	}
}

function megabytes(bytes: number): string {
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export { ENGINE_VERSION, ENGINE_RELEASE_PINNED };
