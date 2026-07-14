// The tier table. If one of these flips, someone has moved a feature across the paywall —
// which is a product decision, not a refactor, and it should fail the build until it is made
// deliberately.
import assert from "node:assert";
import { FEATURES } from "../src/core/features.mjs";
import { isFeatureEnabled, needsEngine, proFeatureKeys } from "../src/shared/featureGates.mjs";

// Free: the whole measurement story. All of it works on mobile, with no engine.
for (const key of ["timeTracking", "revisionSessions", "dwell", "expensiveView", "csvExport"]) {
	assert.equal(FEATURES[key].proOnly, false, `${key} must stay free`);
	assert.equal(FEATURES[key].engine, false, `${key} must never require the engine — it ships on mobile`);
	assert.equal(isFeatureEnabled(FEATURES, key, false), true);
}

// Pro: the two features that compare notes by MEANING, and therefore need the local engine.
for (const key of ["orphanedInvestment", "effortClusters"]) {
	assert.equal(FEATURES[key].proOnly, true, `${key} must stay Pro`);
	assert.equal(needsEngine(FEATURES, key), true, `${key} is semantic and must be flagged as needing the engine`);
	assert.equal(isFeatureEnabled(FEATURES, key, false), false);
	assert.equal(isFeatureEnabled(FEATURES, key, true), true);
}

assert.deepEqual(proFeatureKeys(FEATURES).sort(), ["effortClusters", "orphanedInvestment"]);

// Every gate carries a label — the Pro card renders them, and an undefined bullet is a bug
// the user sees.
for (const [key, gate] of Object.entries(FEATURES)) {
	assert.equal(typeof gate.label, "string", `${key} must have a label`);
	assert.ok(gate.label.length > 0, `${key}'s label must not be empty`);
}

// An unknown key is free, not accidentally paywalled.
assert.equal(isFeatureEnabled(FEATURES, "nonexistent", false), true);

console.log("ok  feature-gates.test.mjs");
