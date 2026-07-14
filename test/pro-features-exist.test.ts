/**
 * THE OTHER HALF OF THE v1.0.0 REGRESSION: `isPro` gated nothing.
 *
 * The shipped build advertised two Pro features — `orphanedInvestment` and `effortClusters` —
 * in the FEATURES table, on the Pro card, and in the README. Neither existed. `isPro` was read
 * in exactly one place (to swap a status line), there was no command, no view surface, and
 * `EngineBroker` was never even imported. A paying customer would have seen "Pro active" and
 * nothing else.
 *
 * This test says: every Pro key in the table is REACHABLE. It drives the real `registerCommands`
 * and asserts the two commands exist, that a free user cannot see them (a palette entry whose
 * only behaviour is a sales pitch should not be in the palette), and that a Pro user CAN — even
 * with no engine installed, because that is where the install offer lives.
 *
 * Against the pre-fix build it fails at the first assertion: the commands are not registered.
 */
import assert from "node:assert";
import { registerCommands } from "../src/commands";
import { FEATURES } from "../src/core/features.mjs";
import { proFeatureKeys } from "../src/shared/featureGates.mjs";
import { DEFAULT_SETTINGS } from "../src/settings";

interface Command {
	id: string;
	name: string;
	callback?: () => void;
	checkCallback?: (checking: boolean) => boolean;
}

function commandsFor(options: { isPro: boolean; engineAvailable: boolean }): Map<string, Command> {
	const registered = new Map<string, Command>();
	const plugin = {
		app: { workspace: { getActiveViewOfType: () => null, getLeavesOfType: () => [] }, vault: {} },
		settings: { ...DEFAULT_SETTINGS, isPro: options.isPro },
		addCommand: (command: Command) => registered.set(command.id, command),
		engineAvailable: () => options.engineAvailable,
		activateView: () => Promise.resolve(),
	};
	registerCommands(plugin as never);
	return registered;
}

/** Which Pro command backs which FEATURES key. A Pro key with no command is a paywall for nothing. */
const PRO_COMMANDS: Record<string, string> = {
	orphanedInvestment: "find-orphaned-investment",
	effortClusters: "group-effort-by-topic",
};

// --- 1. every advertised Pro feature has a real command behind it ----------------------------
{
	const commands = commandsFor({ isPro: true, engineAvailable: true });

	for (const key of proFeatureKeys(FEATURES)) {
		const id = PRO_COMMANDS[key];
		assert.ok(
			id,
			`FEATURES advertises Pro feature "${key}" with no command mapped to it — that is a paywall for vapour`
		);
		const command = commands.get(id);
		assert.ok(command, `the Pro feature "${FEATURES[key].label}" must be reachable: command "${id}" is missing`);
		assert.ok(command.checkCallback, `"${id}" must use checkCallback so it can HIDE when it cannot run`);
		assert.equal(
			command.checkCallback(true),
			true,
			`a Pro user with a desktop engine must be able to run "${id}"`
		);
		// Sentence case, no plugin name (Obsidian prefixes it itself).
		assert.ok(!/effort index/i.test(command.name), `"${id}" must not repeat the plugin name`);
	}
}

// --- 2. a free user sees neither -----------------------------------------------------------------
{
	const commands = commandsFor({ isPro: false, engineAvailable: true });
	for (const id of Object.values(PRO_COMMANDS)) {
		const command = commands.get(id);
		assert.ok(command, `"${id}" is still registered for a free user…`);
		assert.equal(
			command.checkCallback?.(true),
			false,
			`…but HIDDEN from the palette — "${id}" must not fire an error Notice or a sales modal`
		);
	}

	// The free tier is untouched, and every free command still works.
	for (const id of ["open-effort-view", "show-effort-for-note", "export-effort-csv", "clear-activity-log"]) {
		assert.ok(commands.get(id), `the free command "${id}" must survive the Pro layer`);
	}
}

// --- 3. a Pro user with NO engine installed can still reach the feature ----------------------------
// Deliberate: that is where the install offer is. Hiding the command would leave a paying user
// holding a key for a feature whose "on" switch they cannot find.
{
	const commands = commandsFor({ isPro: true, engineAvailable: true });
	assert.equal(
		commands.get("find-orphaned-investment")?.checkCallback?.(true),
		true,
		"engineAvailable() means a desktop engine CLIENT — not an installed binary"
	);
}

// --- 4. on mobile (no engine client at all) the Pro commands are hidden -----------------------------
// There is no engine to offer and no install to run: an entry that can only say "not here" is noise.
{
	const commands = commandsFor({ isPro: true, engineAvailable: false });
	for (const id of Object.values(PRO_COMMANDS)) {
		assert.equal(
			commands.get(id)?.checkCallback?.(true),
			false,
			`"${id}" must be hidden where no engine can ever run`
		);
	}
	assert.ok(commands.get("open-effort-view"), "the free tier still works on mobile — that is the whole point");
}
