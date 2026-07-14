// The suite-key contract (DESIGN 4.6).
//
// ONE Second Read key unlocks Pro in all five add-ons. That is a product decision with a
// security consequence: every plugin verifies against the SAME product id and the SAME public
// key, both read from the vendored shared module — so a plugin can never drift into its own
// keyspace, and a key minted for one add-on's manifest id can never unlock the suite.
//
// NO FIXTURE IS COMMITTED HERE, and none may be. Every key in this file is minted at test
// time from an EPHEMERAL keypair that exists for microseconds inside this process. A
// production-signed `vault-spotlight` Pro key once sat in a public repo and unlocked Pro for
// anyone who read it; the shape of that incident is a test fixture signed with the real
// private key. If a fixture is ever added here, it MUST be minted under
// SUITE_TEST_PRODUCT_ID ("second-read-test") and asserted INVALID against SUITE_PRODUCT_ID.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { verifyLicense } from "../src/shared/verifyLicense.mjs";
import {
	SUITE_LICENSE_PUBLIC_KEY,
	SUITE_PRODUCT_ID,
	SUITE_TEST_PRODUCT_ID,
} from "../src/shared/suiteLicense.mjs";
import { isRevoked, REVOKED_LICENSE_KEYS } from "../src/shared/revokedLicenses.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const b64url = (bytes) =>
	Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

function makeKey(secretKey, payload) {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	const sig = nacl.sign.detached(bytes, secretKey);
	return `${b64url(bytes)}.${b64url(sig)}`;
}

const kp = nacl.sign.keyPair();
const pub = Buffer.from(kp.publicKey).toString("base64");

// --- the happy path --------------------------------------------------------------------
const good = makeKey(kp.secretKey, { product: SUITE_PRODUCT_ID, email: "buyer@example.com" });
let result = verifyLicense(good, SUITE_PRODUCT_ID, pub);
assert.ok(result.valid, "a suite key must verify");
assert.equal(result.email, "buyer@example.com");

// --- the suite id is the ONLY thing keys are bound to ------------------------------------
assert.equal(SUITE_PRODUCT_ID, "second-read", "the suite id is what every key is signed for");
assert.equal(SUITE_TEST_PRODUCT_ID, "second-read-test");

// A key minted for THIS plugin's manifest id must NOT verify. Keys are suite-scoped; a
// per-plugin id is not a licensing identity and must never behave like one.
for (const perPlugin of ["effort-index", "note-decay", "standing-questions", "prior-art", "unwritten"]) {
	const wrongId = makeKey(kp.secretKey, { product: perPlugin, email: "x@y.z" });
	assert.ok(
		!verifyLicense(wrongId, SUITE_PRODUCT_ID, pub).valid,
		`a key signed for "${perPlugin}" must not unlock the suite`
	);
}

// A fixture minted under the test id must never unlock the real product — this is the assertion
// that would have caught the vault-spotlight leak.
const fixture = makeKey(kp.secretKey, { product: SUITE_TEST_PRODUCT_ID, email: "test@example.com" });
assert.ok(verifyLicense(fixture, SUITE_TEST_PRODUCT_ID, pub).valid, "a test-id key verifies against the test id");
assert.ok(
	!verifyLicense(fixture, SUITE_PRODUCT_ID, pub).valid,
	"SECURITY: a key minted under the test id must NEVER unlock the real product"
);

// --- tampering fails closed ----------------------------------------------------------------
const [payloadPart, sigPart] = good.split(".");

const rewritten = b64url(
	new TextEncoder().encode(JSON.stringify({ product: SUITE_PRODUCT_ID, email: "evil@example.com" }))
);
assert.ok(!verifyLicense(`${rewritten}.${sigPart}`, SUITE_PRODUCT_ID, pub).valid, "a rewritten payload fails");

const other = nacl.sign.keyPair();
assert.ok(
	!verifyLicense(good, SUITE_PRODUCT_ID, Buffer.from(other.publicKey).toString("base64")).valid,
	"a key signed by another keypair fails"
);

assert.ok(!verifyLicense("", SUITE_PRODUCT_ID, pub).valid, "an empty key is rejected");
assert.ok(!verifyLicense(`${payloadPart}.@@@`, SUITE_PRODUCT_ID, pub).valid, "bad base64 is rejected");
assert.ok(!verifyLicense("no-dot-at-all", SUITE_PRODUCT_ID, pub).valid, "a malformed key is rejected");

// --- the shipped public key is a real Ed25519 key -------------------------------------------
//
// The vendored public key is what every customer's key is checked against. If it were ever
// replaced by a placeholder, a truncated paste, or an empty string, EVERY paying customer
// would silently drop to free — and nothing else in this suite would notice.
{
	const decoded = Buffer.from(SUITE_LICENSE_PUBLIC_KEY, "base64");
	assert.equal(decoded.length, 32, "an Ed25519 public key is exactly 32 bytes");
	assert.ok(decoded.some((byte) => byte !== 0), "...and is not all zeroes");
	assert.ok(!/^</.test(SUITE_LICENSE_PUBLIC_KEY), "...and is not still the <BASE64_PUBLIC_KEY> placeholder");
}

// --- the plugin cannot mint its own keyspace --------------------------------------------------
//
// product.ts must take the license id FROM the vendored shared module. A hand-typed
// `LICENSE_PRODUCT_ID = "effort-index"` would compile, pass every other test, and quietly
// break the one-key-five-plugins promise for every customer.
{
	const source = fs.readFileSync(path.join(root, "src/product.ts"), "utf8");
	assert.match(
		source,
		/import\s*\{\s*SUITE_PRODUCT_ID\s*\}\s*from\s*"\.\/shared\/suiteLicense\.mjs"/,
		"src/product.ts must import SUITE_PRODUCT_ID from the vendored shared module"
	);
	assert.match(
		source,
		/LICENSE_PRODUCT_ID\s*=\s*SUITE_PRODUCT_ID/,
		"LICENSE_PRODUCT_ID must be the suite id, never a string literal typed out here"
	);
	assert.ok(
		!/LICENSE_PRODUCT_ID\s*=\s*"/.test(source),
		"SECURITY: LICENSE_PRODUCT_ID must never be a hardcoded string"
	);
}

// --- and there is no signing key anywhere near this repo ----------------------------------------
//
// Minting happens in exactly one place: obsidian-plugin-core. A plugin repo that grew its own
// generate-license script would be a second private key on disk, which is how a keypair leaks.
assert.ok(
	!fs.existsSync(path.join(root, "scripts/generate-license.mjs")),
	"a plugin repo must not be able to mint keys — minting lives only in obsidian-plugin-core"
);
for (const entry of fs.readdirSync(path.join(root, "scripts"))) {
	assert.ok(!entry.endsWith(".key"), `SECURITY: a private key must never exist here (found ${entry})`);
}

// --- revocation is checked BEFORE the signature ----------------------------------------------
//
// A leaked key is a VALID signature. The only way to kill one without rotating the keypair —
// which would revoke Pro for every paying customer — is to reject it by value.
assert.deepEqual([...REVOKED_LICENSE_KEYS], [], "the revocation list ships empty");
assert.equal(isRevoked("anything"), false);
assert.equal(isRevoked(""), false);

// --- ...and this plugin does not own a second copy of that decision -----------------------------
//
// `verifySuiteLicense` is, in its own words, "THE ONE FUNCTION THAT DECIDES WHETHER A KEY UNLOCKS
// PRO. Every plugin calls this and nothing else." It exists because the composition below it —
// revocation, THEN signature — was hand-copied into five LicenseManager.ts files that no test, no
// linter and no drift check ever compared. This repo's LicenseManager was still such a copy: it
// imported isRevoked and verifyLicense and re-derived the composition itself. It was correct, and
// that is exactly the problem — nothing here would have noticed if it stopped being correct, and a
// single suite keypair makes the by-value denylist the ONLY revocation mechanism we have.
//
// LicenseManager.ts is NOT part of the vendored shared tree, so the MANIFEST.sha256 drift gate
// cannot see it. This assertion is the gate for this one file. (The behaviour it buys — a revoked
// key with a genuinely valid signature rejected on the plugin's own verify path — is proved in
// license-manager.test.ts.)
{
	const source = fs.readFileSync(path.join(root, "src/license/LicenseManager.ts"), "utf8");
	// The file is allowed to TALK about the composition it no longer owns (its header explains
	// exactly why it must not own it). Only executable code is checked.
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

	assert.match(
		code,
		/import\s*\{[^}]*\bverifySuiteLicense\b[^}]*\}\s*from\s*"\.\.\/shared\/suiteLicense\.mjs"/,
		"LicenseManager must take its decision from the shared verifySuiteLicense"
	);
	assert.ok(
		/\bverify\b[^\n]*=\s*verifySuiteLicense\b/.test(code) || /\bverifySuiteLicense\s*\(/.test(code),
		"...and `verify` must BE that function — bound to it or calling it — not merely import it"
	);
	assert.ok(
		!/\bisRevoked\b/.test(code),
		"SECURITY: LicenseManager must not re-implement revocation — that composition lives in suiteLicense.mjs"
	);
	assert.ok(
		!/\bverifyLicense\s*\(/.test(code),
		"SECURITY: LicenseManager must not call verifyLicense directly — it would be a second, uncompared copy of the decision"
	);
	assert.ok(
		!/\bSUITE_LICENSE_PUBLIC_KEY\b/.test(code),
		"LicenseManager must not name the public key: choosing which key to trust IS the decision it delegates"
	);
	assert.ok(
		!/from\s*"\.\.\/shared\/revokedLicenses\.mjs"/.test(code),
		"SECURITY: LicenseManager must not import the denylist at all — it does not get to decide when to consult it"
	);
}

console.log("ok  license.test.mjs");
