/**
 * Outbound links, in one place.
 *
 * The href is sanitised to http(s) — a value that ever became user-editable (or a constant left
 * as a placeholder) must not be able to smuggle in `javascript:` — and it opens in a new tab
 * with rel="noopener noreferrer". An anchor, never `window.open`: Obsidian routes an anchor to
 * the OS browser on desktop AND on mobile.
 *
 * There is NO fallback URL any more, and that is the point. The old version fell back to
 * `PURCHASE_URL`, so a malformed link silently became a link to the checkout — and once
 * PURCHASE_URL became an honest `null` (there is no checkout yet), that fallback would have
 * been a link to the string "null". A URL we cannot vouch for now renders as PLAIN TEXT: no
 * anchor, nothing to click, nowhere to be sent.
 */

/** The URL, if it is a well-formed http(s) one. Null otherwise — and null means "no link". */
export function safeHttpUrl(url: string | null | undefined): string | null {
	if (typeof url !== "string" || url.trim() === "") return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
	} catch {
		// Not a parseable URL — fall through.
	}
	return null;
}

/**
 * An anchor when the URL is safe; a plain span when it is not. The caller gets an element either
 * way, and the user is never handed a dead or hostile link to click.
 */
export function createExternalLink(
	parent: HTMLElement,
	options: { text: string; url: string | null; cls?: string }
): HTMLElement {
	const href = safeHttpUrl(options.url);
	if (!href) return parent.createSpan({ cls: options.cls, text: options.text });

	const link = parent.createEl("a", { cls: options.cls, text: options.text, href });
	link.setAttr("target", "_blank");
	link.setAttr("rel", "noopener noreferrer");
	return link;
}
