import { SUITE_PRODUCT_ID } from "./shared/suiteLicense.mjs";

/**
 * This plugin's identity and its marketing copy, in one place — every CTA, the settings
 * tab, and the upsell modal read from here.
 *
 * The one thing that is NOT this plugin's identity is what a license key is signed for.
 * A Second Read key is signed for the SUITE, and the suite id comes from the vendored
 * shared module, not from a constant typed out here. That is what makes "one key, five
 * plugins" structurally impossible to get wrong.
 */

/** This plugin's manifest id. NOT the license product id. */
export const PRODUCT_ID = "effort-index";
export const PRODUCT_NAME = "Effort Index";

/** What a license key is signed for. Shared by all five Second Read add-ons. */
export const LICENSE_PRODUCT_ID = SUITE_PRODUCT_ID; // "second-read"

export const SUITE_NAME = "Second Read";
export const PRO_NAME = "Second Read Pro";
export const PRO_PRICE_LABEL = "$29 one-time";

/** TODO(launch): create the Buy Me a Coffee "extra" for the suite and paste its id here.
 *  Until then this points at the author's page, which is a working destination — a broken
 *  or placeholder URL in a shipped build is a review finding. See DESIGN 4.7 / OQ 10.2. */
export const PURCHASE_URL = "https://buymeacoffee.com/vaultspotlight";

export const PRO_TAGLINE =
	"One key unlocks Pro in all five Second Read add-ons: Note Decay, Standing Questions, Effort Index, Prior Art, and Unwritten. $29 one-time, no subscription, no account.";

/** What a free user of THIS add-on is missing, in one phrase. */
export const PRO_UNLOCK_SUMMARY = "orphaned-investment detection and topic-grouped effort reports";

/** Contextual upsell copy, keyed by the feature the user reached for. */
export const PRO_UPSELL: Record<string, string> = {
	orphanedInvestment: "Orphaned-investment detection is a Pro feature. " + PRO_TAGLINE,
	effortClusters: "Grouping the effort report by topic is a Pro feature. " + PRO_TAGLINE,
};
