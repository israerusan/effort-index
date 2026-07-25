import { SUITE_PRODUCT_ID } from "./shared/suiteLicense.mjs";

/**
 * This plugin's identity and its marketing copy, in one place — every CTA, the settings
 * tab, and the Pro panels read from here.
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

/**
 * THE CHECKOUT SWITCH — the one edit that opens sales.
 *
 * `null` means there is no checkout yet. Not "a placeholder URL", not "the author's tip-jar
 * page dressed up as a buy button": nothing. Every purchase CTA in this add-on is derived
 * from this constant, so while it is null the Pro card renders its features and says plainly
 * that purchasing is not open — and renders NO link, because a button that takes $29 for a
 * key that nobody can deliver yet is worse than no button at all. (An earlier build shipped
 * exactly that: an "Unlock Pro" anchor to a generic BuyMeACoffee handle page, for two features
 * that did not exist. Both halves of that are now fixed — the features are built, and this
 * constant is honest about the till.)
 *
 * To open sales: set this to the real suite checkout URL (DESIGN 4.7 — a processor that can
 * verify a webhook and email a signed key; BMAC cannot). Everything else follows from it, and
 * `pro-card.test.ts` asserts both halves of the switch.
 */
export const PURCHASE_URL: string | null = "https://buymeacoffee.com/vaultspotlight/e/560213";

/** True only when PURCHASE_URL names a real checkout. Nothing else may decide this. */
export const CHECKOUT_OPEN: boolean = PURCHASE_URL !== null;

/** What the Pro card says while the till is closed. Honest, and short. */
export const PURCHASE_PENDING_COPY =
	"Purchasing is not open yet — there is nothing to buy, no waitlist, and no payment link. " +
	"The Pro features below are built and shipping in this version; they unlock the moment a key " +
	"is pasted above. If you already have a Second Read key, it works right now.";

export const PRO_TAGLINE =
	"One key unlocks Pro in all five Second Read add-ons: Note Decay, Standing Questions, Effort Index, Prior Art, and Unwritten. $29 one-time, no subscription, no account.";

/** What a free user of THIS add-on is missing, in one phrase. */
export const PRO_UNLOCK_SUMMARY = "orphaned-investment detection and topic-grouped effort reports";

/** Contextual copy, keyed by the feature the user reached for. */
export const PRO_UPSELL: Record<string, string> = {
	orphanedInvestment:
		"Orphaned-investment detection finds the notes you poured hours into whose ideas never turned " +
		"up anywhere else in your vault. It compares notes by meaning, so it needs the local semantic engine.",
	effortClusters:
		"Topic-grouped effort reporting collects your expensive notes into the subjects they actually " +
		"belong to, so you can see where the time went. It compares notes by meaning, so it needs the local semantic engine.",
};
