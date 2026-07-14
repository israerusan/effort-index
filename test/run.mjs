// Test runner. Bundles every test/*.test.ts (aliasing `obsidian` to a Node-safe stub so
// the real src/ code runs unchanged), executes them, then runs the plain .mjs tests.
// Any thrown assertion fails the process. No framework, no config, no registration:
// a new test/*.test.mjs file is picked up simply by existing.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// The shared license verifier decodes base64 with atob(), which the browser has and
// older Node did not. Node 16+ ships it globally; this keeps the suite honest on any
// runtime by proving the polyfill is never silently required.
if (typeof globalThis.atob !== "function") {
  globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const buildDir = path.join(testDir, ".build");
fs.mkdirSync(buildDir, { recursive: true });

const tsTests = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.ts"))
  .sort();

for (const file of tsTests) {
  const outfile = path.join(buildDir, file.replace(/\.ts$/, ".cjs"));
  await esbuild.build({
    entryPoints: [path.join(testDir, file)],
    bundle: true,
    outfile,
    format: "cjs",
    platform: "node",
    target: "node18",
    logLevel: "warning",
    alias: {
      obsidian: path.join(testDir, "obsidian-stub.ts"),
    },
  });
  // A .test.ts CANNOT use top-level await (esbuild's CJS output rejects it, which is the same
  // invariant main.js lives under), so an async test exports the promise its body returns as
  // `done` and THIS is what waits for it. Two things depend on that wait:
  //   - a rejected assertion has to fail the suite, not print after the runner said "ok";
  //   - the writer election lives on a GLOBAL registry shared by every bundle in this process,
  //     so two async tests running interleaved would elect writers into each other's registry
  //     and steal each other's slots. The suite must be strictly sequential.
  // `require` (not `import`) because the module is CJS and this reads its exports object
  // directly, with no ESM named-export detection to get in the way.
  const mod = require(outfile);
  if (typeof mod?.done?.then === "function") await mod.done;
  console.log(`ok  ${file}`);
}

const mjsTests = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();

for (const file of mjsTests) {
  await import(pathToFileURL(path.join(testDir, file)).href);
}

console.log("\nAll tests passed.");
