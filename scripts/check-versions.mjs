#!/usr/bin/env node
// Asserts every place a dif version number is stamped agrees with the Rust
// workspace version. Run by CI on every push (ci.yml) and again against the
// release tag before any build/publish step (release.yml), so a tag whose
// tree has a stale version somewhere (most notoriously: react/svelte's
// peerDependency on @dif.sh/sdk, which `npm version` never touches) aborts
// loudly instead of shipping a broken install.
//
// Usage: node scripts/check-versions.mjs
// Exits 0 and prints a short OK line if everything matches, exits 1 and
// prints every mismatch by name otherwise.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];

function check(name, actual, expected) {
  if (actual !== expected) {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- Resolve V from cli/Cargo.toml [workspace.package] -------------------
const cargoTomlPath = join(root, "cli", "Cargo.toml");
const cargoToml = readFileSync(cargoTomlPath, "utf8");

const workspacePackageMatch = cargoToml.match(
  /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/,
);
if (!workspacePackageMatch) {
  console.error("cli/Cargo.toml: no [workspace.package] section found");
  process.exit(1);
}
const versionMatch = workspacePackageMatch[1].match(/^\s*version\s*=\s*"([^"]+)"/m);
if (!versionMatch) {
  console.error("cli/Cargo.toml: no version = \"...\" found in [workspace.package]");
  process.exit(1);
}
const V = versionMatch[1];

// --- package.json versions -------------------------------------------------
for (const pkg of ["cli", "sdk", "react", "svelte"]) {
  const pkgPath = join(root, "cli", "packages", pkg, "package.json");
  const pkgJson = readJson(pkgPath);
  check(`cli/packages/${pkg}/package.json .version`, pkgJson.version, V);
}

// --- peerDependencies on @dif.sh/sdk (react + svelte) ----------------------
for (const pkg of ["react", "svelte"]) {
  const pkgPath = join(root, "cli", "packages", pkg, "package.json");
  const pkgJson = readJson(pkgPath);
  const actual = pkgJson.peerDependencies?.["@dif.sh/sdk"];
  check(
    `cli/packages/${pkg}/package.json .peerDependencies["@dif.sh/sdk"]`,
    actual,
    `^${V}`,
  );
}

// --- sdk's generated version stamp -----------------------------------------
const versionTsPath = join(root, "cli", "packages", "sdk", "src", "version.ts");
const versionTs = readFileSync(versionTsPath, "utf8");
if (!versionTs.includes(V)) {
  failures.push(`cli/packages/sdk/src/version.ts: does not contain "${V}"`);
}

// --- installer's fallback DEFAULT_VERSION ----------------------------------
const installShPath = join(root, "dist", "install.sh");
const installSh = readFileSync(installShPath, "utf8");
const expectedDefaultVersion = `DEFAULT_VERSION="v${V}"`;
if (!installSh.includes(expectedDefaultVersion)) {
  failures.push(`dist/install.sh: does not contain '${expectedDefaultVersion}'`);
}

// --- release tag (only when running against a tag build) ------------------
const releaseTag = process.env.RELEASE_TAG;
if (releaseTag) {
  const tagMatch = releaseTag.match(/^v(\d+\.\d+\.\d+)/);
  if (tagMatch) {
    check("RELEASE_TAG numeric part", tagMatch[1], V);
  }
}

if (failures.length > 0) {
  console.error(`check-versions: ${failures.length} mismatch(es) against V=${V}:`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`check-versions: OK — everything matches V=${V}`);
