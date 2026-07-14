/**
 * Effort Index's tier table (DESIGN 4.4). The gate ENGINE lives in the vendored
 * `src/shared/featureGates.mjs`; the table itself is per-plugin and lives here.
 *
 * `engine: true` means the feature needs the local semantic engine — desktop only, and
 * only after the user has explicitly downloaded it. Those two features ship in a later
 * phase; they are declared now so the paywall is a single, reviewable object rather than
 * a condition scattered across the UI.
 *
 * Moving a key across `proOnly` is a product decision, not a refactor: `feature-gates.test.mjs`
 * fails the build until it is made deliberately.
 */
export const FEATURES = Object.freeze({
	timeTracking: { proOnly: false, engine: false, label: "Active editing time per note" },
	revisionSessions: { proOnly: false, engine: false, label: "Revision sessions" },
	dwell: { proOnly: false, engine: false, label: "Dwell time" },
	expensiveView: { proOnly: false, engine: false, label: "Most expensive notes you stopped opening" },
	csvExport: { proOnly: false, engine: false, label: "Export effort data as CSV" },
	orphanedInvestment: {
		proOnly: true,
		engine: true,
		label: "Find expensive notes whose ideas were never reused",
	},
	effortClusters: { proOnly: true, engine: true, label: "Group the effort report by topic" },
});
