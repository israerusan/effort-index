/**
 * THE REVOCATION BRANCH, ON THIS PLUGIN'S OWN VERIFY PATH.
 *
 * `shared/suiteLicense.mjs` calls `verifySuiteLicense` "THE ONE FUNCTION THAT DECIDES WHETHER
 * A KEY UNLOCKS PRO. Every plugin calls this and nothing else" — because the composition it
 * encodes (revocation checked BEFORE the signature) used to be hand-copied into five
 * `src/license/LicenseManager.ts` files that nothing ever compared. This repo's LicenseManager
 * was still one of those copies. It happened to be correct, so nothing was broken today; but
 * with a SINGLE suite keypair the by-value denylist is the only revocation mechanism that
 * exists, and a copy that silently loses its `isRevoked` call keeps unlocking Pro with a
 * revoked, leaked key forever. Nothing in the suite would have noticed.
 *
 * So this test drives `LicenseManager.verify` — the exact entry point `main.ts` calls — and
 * makes the REVOCATION BRANCH ACTUALLY RUN. That requires a key whose signature is GENUINELY
 * VALID: a key that fails the signature check would be rejected either way, and the test would
 * pass against a LicenseManager that never consults the denylist at all. Hence the ordering of
 * the blocks below — the same key is first proved to unlock Pro, and only then revoked.
 *
 * WHY THIS CANNOT LEAK A KEY. The keypair is ephemeral: `nacl.sign.keyPair()` inside this
 * process, alive for microseconds, never written down. Nothing minted here verifies against
 * the shipped `SUITE_LICENSE_PUBLIC_KEY` (asserted at the bottom), so even if this file's
 * output were pasted into a public repo it would unlock nothing. The real private key exists
 * exactly once, in obsidian-plugin-core, and is nowhere near this repo.
 */
import assert from "node:assert";
import nacl from "tweetnacl";
import { LicenseManager } from "../src/license/LicenseManager";
import { verifyLicense } from "../src/shared/verifyLicense.mjs";
import { SUITE_PRODUCT_ID, SUITE_TEST_PRODUCT_ID, verifySuiteLicense } from "../src/shared/suiteLicense.mjs";

// --- 0. IT IS THE SHARED FUNCTION, BY REFERENCE ------------------------------------------------
//
// Not "equivalent to" it. The five hand-copies were equivalent to it too, on the day they were
// written. A method body here is a place for the composition to rot; there is now no body.
assert.equal(
	LicenseManager.verify,
	verifySuiteLicense,
	"LicenseManager.verify must BE verifySuiteLicense — not a second implementation of it"
);

const b64url = (bytes: Uint8Array) =>
	Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const pair = nacl.sign.keyPair();
const ephemeralPublicKey = Buffer.from(pair.publicKey).toString("base64");

function mint(payload: Record<string, string>): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	return `${b64url(bytes)}.${b64url(nacl.sign.detached(bytes, pair.secretKey))}`;
}

/** A key with a REAL Ed25519 signature over a REAL suite payload — signed by a throwaway key. */
const leaked = mint({
	product: SUITE_PRODUCT_ID,
	email: "buyer@example.com",
	issued: "2026-01-01T00:00:00.000Z",
});

/**
 * The test seam, in the shape a leaked key actually has in the world:
 *   - `verifyLicense` is the REAL verifier, real crypto, real product-id check — pointed at the
 *     ephemeral public key instead of the shipped one, because minting under the real one is
 *     forbidden (and impossible: the private half is not here).
 *   - `isRevoked` is the real denylist's semantics (exact string, trimmed) over a list we can
 *     actually add to. The shipped `REVOKED_LICENSE_KEYS` is frozen and empty, which is the
 *     whole reason the revocation branch is otherwise unreachable from a test.
 * Both are logged, so the ORDER is observable and not merely assumed.
 */
const denylist = new Set<string>();
const calls: string[] = [];
const deps = {
	isRevoked: (key: string) => {
		calls.push("isRevoked");
		return denylist.has(String(key ?? "").trim());
	},
	verifyLicense: (key: string, product: string) => {
		calls.push("verifyLicense");
		return verifyLicense(key, product, ephemeralPublicKey);
	},
};

// --- 1. THE ANTI-VACUITY BLOCK: the key is genuinely good ------------------------------------
//
// Before revoking it, prove that THIS key, through THIS entry point, unlocks Pro. Without this,
// block 2 proves nothing: a key rejected for a bad signature looks exactly like a key rejected
// for being revoked, and a LicenseManager with no denylist check at all would sail through.
{
	calls.length = 0;
	const result = LicenseManager.verify(leaked, deps);
	assert.equal(result.valid, true, "the fixture must be a genuinely valid suite key, or block 2 is vacuous");
	assert.equal(result.email, "buyer@example.com");
	assert.deepEqual(calls, ["isRevoked", "verifyLicense"], "a live key is checked against the denylist first, then verified");
}

// --- 2. REVOKED BY VALUE: the same valid key must now unlock nothing ---------------------------
{
	denylist.add(leaked);
	calls.length = 0;
	const result = LicenseManager.verify(leaked, deps);
	assert.equal(
		result.valid,
		false,
		"a REVOKED key must not unlock Pro on this plugin's verify path, however valid its signature"
	);
	assert.match(result.error ?? "", /revoked/i, "and the user must be told it was revoked, not that it is malformed");

	// The order is not decoration: rejecting on the way IN, before any crypto runs, is what
	// stops a later refactor that returns early on a valid signature from losing the check.
	assert.deepEqual(calls, ["isRevoked"], "revocation is checked FIRST and short-circuits — the signature is never verified");
}

// --- 3. ...and padding does not smuggle it back in ---------------------------------------------
{
	const padded = LicenseManager.verify(`  ${leaked}  `, deps);
	assert.equal(padded.valid, false, "a revoked key with whitespace around it is still revoked");
	assert.match(padded.error ?? "", /revoked/i);
}

// --- 4. Against the REAL dependencies: nothing minted here unlocks anything ----------------------
//
// No deps argument — this is the production path, byte for byte what main.ts runs.
{
	assert.equal(
		LicenseManager.verify(leaked).valid,
		false,
		"SECURITY: a key signed by a throwaway keypair must never verify against the shipped suite key"
	);
	const fixture = mint({ product: SUITE_TEST_PRODUCT_ID, email: "test@example.com", issued: "x" });
	assert.equal(LicenseManager.verify(fixture).valid, false, "a test-id fixture must never unlock the real product");
	assert.equal(LicenseManager.verify("").valid, false, "an empty key is not Pro");
	assert.equal(LicenseManager.verify("not-a-key").valid, false, "junk is not Pro");
	assert.equal(LicenseManager.verify(undefined as unknown as string).valid, false, "a missing key must not throw");
}

console.log("ok  license-manager.test.ts (revocation branch exercised with a genuinely valid signature)");
