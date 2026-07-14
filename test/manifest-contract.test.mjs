// Manifest/versions contract — the checks Obsidian's review runs on manifest.json that
// eslint-plugin-obsidianmd's `validate-manifest` cannot (eslint does not lint the JSON
// file without a JSON language plugin). This locks the class of issues that DELISTS a
// plugin — the review bot does a blunt case-insensitive substring match for "obsidian"
// and "plugin" in name/description/id, with no exceptions — plus release-version
// consistency, so a tag can never disagree with the manifest.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));

for (const key of ["name", "description", "id"]) {
	for (const word of ["obsidian", "plugin"]) {
		assert.ok(
			!new RegExp(word, "i").test(manifest[key]),
			`manifest.${key} must not contain "${word}" (the review bot rejects it)`
		);
	}
}

assert.ok(/^[a-z0-9-]+$/.test(manifest.id), "manifest.id must be lowercase letters/digits/hyphens");
assert.ok(
	manifest.minAppVersion && /^\d+\.\d+\.\d+$/.test(manifest.minAppVersion),
	"manifest.minAppVersion must be set (x.y.z)"
);
assert.ok(manifest.author, "manifest.author must be set");
assert.equal(typeof manifest.isDesktopOnly, "boolean", "manifest.isDesktopOnly must be a boolean");
assert.ok(
	/\.$/.test(manifest.description),
	"manifest.description must end with a period (review style rule)"
);

assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), "manifest.version must be x.y.z");
assert.equal(manifest.version, pkg.version, "manifest.json and package.json versions must match");
assert.ok(versions[manifest.version], `versions.json must contain an entry for ${manifest.version}`);

console.log("ok  manifest-contract.test.mjs");
