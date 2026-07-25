/**
 * THE REGRESSION TEST FOR WHAT v1.0.0 ACTUALLY SHIPPED.
 *
 * The settings tab rendered "Second Read Pro — $29 one-time", bulleted two features, and gave
 * the user a live "Unlock Pro" anchor to https://buymeacoffee.com/vaultspotlight — a generic
 * handle page, not a product. Behind it: `isPro` gated NOTHING. A buyer would have paid $29,
 * waited for a hand-emailed key, pasted it, seen "Pro active — …", and observed no change
 * whatsoever in the add-on.
 *
 * Two things had to be true before that card could ever be honest, and this file asserts both:
 *
 *   1. THE FEATURES EXIST. `proFeatureKeys(FEATURES)` is not a wish list — every key on it is
 *      reachable from the plugin (see pro-features-exist.test.ts for the command surface).
 *   2. THE TILL IS HONEST. `PURCHASE_URL` now names the real Second Read checkout
 *      (buymeacoffee.com/vaultspotlight/e/560213), so the card renders exactly one live
 *      "Unlock Pro" anchor pointing at it — and no longer shows the "purchasing opens soon"
 *      pending copy. When PURCHASE_URL was null the button was absent; flipping the constant
 *      is all it took, and this file asserts the open state in both directions.
 */
import assert from "node:assert";
import { FakeEl, Setting } from "./obsidian-stub";
import { EffortIndexSettingTab } from "../src/ui/SettingsTab";
import { createExternalLink, safeHttpUrl } from "../src/ui/links";
import { CHECKOUT_OPEN, PURCHASE_URL, PURCHASE_PENDING_COPY } from "../src/product";
import { FEATURES } from "../src/core/features.mjs";
import { proFeatureKeys } from "../src/shared/featureGates.mjs";
import { DEFAULT_SETTINGS } from "../src/settings";

function tabFor(isPro: boolean): EffortIndexSettingTab {
	Setting.reset();
	const plugin = {
		app: {},
		settings: { ...DEFAULT_SETTINGS, isPro },
		licenseError: undefined,
		engine: null, // mobile / no engine client: the Pro CARD must render regardless
		engineStatus: null,
		queueSave: () => undefined,
		refreshLicense: () => Promise.resolve(false),
		refreshEngineStatus: () => Promise.resolve(null),
		flushPendingSave: () => Promise.resolve(),
		activateView: () => Promise.resolve(),
	};
	const tab = new EffortIndexSettingTab(plugin as never);
	tab.display();
	return tab;
}

const anchorsIn = (root: FakeEl): FakeEl[] => root.findAll((el) => el.tag === "a");

// --- 1. THE LIVE PURCHASE CTA NOW THAT THE SECOND READ CHECKOUT IS OPEN ----------------------
{
	const tab = tabFor(false);
	const root = tab.containerEl as unknown as FakeEl;

	const anchors = anchorsIn(root);
	assert.equal(
		anchors.length,
		1,
		`a free user is offered exactly one purchase link now that the checkout is open — found ${String(
			anchors.map((a) => a.attrs.href)
		)}`
	);
	assert.equal(anchors[0]!.attrs.href, PURCHASE_URL, "and the one anchor points at the real checkout");

	assert.equal(
		PURCHASE_URL,
		"https://buymeacoffee.com/vaultspotlight/e/560213",
		"product.ts names the real Second Read checkout"
	);
	assert.equal(CHECKOUT_OPEN, true, "and CHECKOUT_OPEN is derived from it, never set by hand");

	const text = root.text();
	assert.ok(
		/unlock pro/i.test(text),
		"the card offers a live 'Unlock Pro' button now that there is something to buy"
	);
}

// --- 2. the card still SELLS the features — it just does not take money for them -------------
{
	const root = tabFor(false).containerEl as unknown as FakeEl;
	const text = root.text();

	assert.ok(/Second Read Pro/.test(text), "the card names the product");
	assert.ok(!text.includes(PURCHASE_PENDING_COPY), "and no longer says purchasing is closed");

	for (const key of proFeatureKeys(FEATURES)) {
		assert.ok(
			text.includes(FEATURES[key].label),
			`the card must list what Pro actually does — missing "${FEATURES[key].label}"`
		);
	}
	assert.deepEqual(proFeatureKeys(FEATURES), ["orphanedInvestment", "effortClusters"]);
}

// --- 3. a Pro user is not shown the pitch at all -----------------------------------------------
{
	const root = tabFor(true).containerEl as unknown as FakeEl;
	const text = root.text();
	assert.ok(/Pro active/.test(text), "a valid key says so");
	assert.ok(!text.includes(PURCHASE_PENDING_COPY), "and is not pitched at");
	assert.equal(anchorsIn(root).length, 0);
}

// --- 4. the Pro rows are locked for free and live for Pro ---------------------------------------
{
	Setting.reset();
	tabFor(false);
	const lockedRows = Setting.instances.filter((s) =>
		s.settingEl.classes.has("effort-index-setting-locked")
	);
	assert.ok(lockedRows.length >= 2, "the Pro knobs are visibly locked, not missing");
	for (const rowSetting of lockedRows) {
		assert.equal(rowSetting.controls().length, 0, "a locked row must have no working control");
		assert.equal(rowSetting.extraButtons[0]?.icon, "lock");
		assert.equal(rowSetting.extraButtons[0]?.disabled, true);
	}

	Setting.reset();
	tabFor(true);
	const orphanRow = Setting.instances.find((s) => s.name.startsWith(FEATURES.orphanedInvestment.label));
	assert.ok(orphanRow, "a Pro user gets the orphan threshold row");
	assert.equal(orphanRow.sliders.length, 1, "and it is a working slider, not a lock");
	assert.equal(orphanRow.sliders[0].value, DEFAULT_SETTINGS.orphanMaxScore);
}

// --- 5. the switch works in the OTHER direction too ----------------------------------------------
// The whole point of the constant is that opening sales is one edit. Prove the link machinery is
// still there and still safe, so flipping PURCHASE_URL is all it takes.
{
	const parent = new FakeEl();
	const link = createExternalLink(parent as never, { text: "Unlock Pro", url: "https://example.test/buy" });
	assert.equal((link as unknown as FakeEl).tag, "a");
	assert.equal((link as unknown as FakeEl).attrs.href, "https://example.test/buy");
	assert.equal((link as unknown as FakeEl).attrs.rel, "noopener noreferrer");
	assert.equal((link as unknown as FakeEl).attrs.target, "_blank");

	// A URL we cannot vouch for renders as TEXT, never as an anchor to somewhere else. The old
	// version fell back to PURCHASE_URL, which today would be a link to the string "null".
	const unsafe = createExternalLink(parent as never, { text: "Unlock Pro", url: "javascript:alert(1)" });
	assert.equal((unsafe as unknown as FakeEl).tag, "span", "a javascript: URL must not become an anchor");
	assert.equal(safeHttpUrl(null), null);
	assert.equal(safeHttpUrl(""), null);
	assert.equal(safeHttpUrl("https://ok.test"), "https://ok.test");
}
