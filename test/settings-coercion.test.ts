/**
 * data.json is a file on the user's disk. Obsidian Sync merges it, a crash truncates it, a
 * user edits it, an older build wrote it. NOTHING in it is guaranteed to have the type the
 * `EffortIndexSettings` interface promises.
 *
 * The bug: `loadSettings()` coerced `excludeFolders` and `isPro` and nothing else, so a
 * `licenseKey` that came back as a NUMBER reached `refreshLicense()`, which calls
 * `.trim()` on it. `TypeError: this.settings.licenseKey.trim is not a function`, thrown from
 * inside `onload()` — the plugin fails to load with a stack trace and the user gets no view,
 * no settings tab, and no way to fix the file that broke it. This drives the REAL plugin
 * class's real `loadSettings()` + `refreshLicense()`, which is the exact path that threw.
 */
import assert from "node:assert";
import type { App, PluginManifest } from "obsidian";
import EffortIndexPlugin from "../src/main";
import { DEFAULT_SETTINGS, coerceSettings } from "../src/settings";

(globalThis as Record<string, unknown>).window = {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: number) => clearTimeout(id),
	setInterval: () => 1,
	clearInterval: () => undefined,
};

const app = {
	vault: { configDir: ".obsidian" },
	// A save re-renders the panel; there is none open here.
	workspace: { getLeavesOfType: () => [] },
} as unknown as App;
const manifest = { id: "effort-index", version: "1.0.0" } as unknown as PluginManifest;

/** The real plugin, with only the two data.json primitives stubbed. */
function pluginWith(data: unknown): { plugin: EffortIndexPlugin; saved: unknown[] } {
	const plugin = new EffortIndexPlugin(app, manifest);
	const saved: unknown[] = [];
	Object.assign(plugin, {
		loadData: () => Promise.resolve(data),
		saveData: (value: unknown) => {
			saved.push(value);
			return Promise.resolve();
		},
	});
	return { plugin, saved };
}

async function main(): Promise<void> {
	// --- THE CRASH -------------------------------------------------------------------------
	{
		// Every string field is the wrong type. Not one of them may reach a `.trim()`.
		const { plugin } = pluginWith({ licenseKey: 42, licenseEmail: null, signalsWriterId: { id: 1 } });
		await plugin.loadSettings();
		// This is the call that threw TypeError inside onload().
		await plugin.refreshLicense();

		assert.equal(plugin.settings.licenseKey, "", "a non-string licenseKey is ABSENT, not the string '42'");
		assert.equal(plugin.settings.licenseEmail, "");
		assert.equal(plugin.settings.isPro, false);
		assert.equal(
			typeof plugin.settings.signalsWriterId,
			"string",
			"the shard id must be a string — it is interpolated into the log's file name"
		);
		assert.ok(plugin.settings.signalsWriterId.length > 0, "a corrupt shard id is re-minted, not carried through");
	}

	// --- a forged entitlement ---------------------------------------------------------------
	{
		const { plugin } = pluginWith({ isPro: true });
		await plugin.loadSettings();
		await plugin.refreshLicense();
		assert.equal(plugin.settings.isPro, false, "isPro with no key does not survive a load");
	}

	// --- prototype pollution ------------------------------------------------------------------
	{
		const hostile: unknown = JSON.parse('{"__proto__":{"isPro":true},"licenseKey":"x"}');
		const settings = coerceSettings(hostile);
		assert.equal(settings.isPro, false);
		assert.equal(
			({} as Record<string, unknown>).isPro,
			undefined,
			"a hostile data.json must not forge isPro onto every object in the runtime"
		);
	}

	// --- everything else, coerced ---------------------------------------------------------------
	assert.deepEqual(coerceSettings(null), DEFAULT_SETTINGS, "no data.json at all is the defaults, exactly");
	assert.deepEqual(coerceSettings("not an object"), DEFAULT_SETTINGS);
	assert.deepEqual(coerceSettings([1, 2, 3]), DEFAULT_SETTINGS);
	assert.deepEqual(coerceSettings({ excludeFolders: "Archive" }).excludeFolders, [], "a string is not a folder list");
	assert.deepEqual(coerceSettings({ excludeFolders: ["A", 7, null] }).excludeFolders, ["A"]);
	assert.equal(coerceSettings({ isPro: "yes" }).isPro, false, "only the boolean true is Pro");

	// A NaN idle cutoff would become `setInterval(fn, NaN)` and a slider with no position.
	assert.equal(coerceSettings({ idleCutoffSeconds: "60" }).idleCutoffSeconds, DEFAULT_SETTINGS.idleCutoffSeconds);
	assert.equal(coerceSettings({ staleDays: NaN }).staleDays, DEFAULT_SETTINGS.staleDays);
	assert.equal(coerceSettings({ dwellCapMinutes: Infinity }).dwellCapMinutes, DEFAULT_SETTINGS.dwellCapMinutes);
	assert.equal(coerceSettings({ staleDays: 14 }).staleDays, 14, "a GOOD value is still passed through");
	assert.equal(coerceSettings({ licenseKey: "abc" }).licenseKey, "abc");
}

export const done = main().then(undefined, (error: unknown) => {
	console.error(error);
	process.exit(1);
});
