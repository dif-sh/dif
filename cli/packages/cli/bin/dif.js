#!/usr/bin/env node
// Thin Node shim that exec's the platform-matched Rust binary. The actual
// binary is downloaded by ./install.js as a postinstall step and lives
// alongside this file in the same `bin/` directory.
//
// We use spawnSync with `stdio: "inherit"` so the user's terminal sees the
// binary's output directly — no buffering, no signal-handling indirection.

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const binaryName = process.platform === "win32" ? "dif.exe" : "dif";
const binaryPath = path.join(__dirname, binaryName);

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error(
      `@dif.sh/cli: binary not found at ${binaryPath}.\n` +
      `If you skipped postinstall, run \`node ${path.join(__dirname, "..", "install.js")}\` ` +
      `or reinstall the package.`,
    );
    process.exit(127);
  }
  console.error(`@dif.sh/cli: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  // The binary was killed by a signal. Re-raise it so our own exit status
  // reflects that (128+n convention) instead of reporting success — CI
  // scripts checking `$?` must not treat an interrupted build as passing.
  process.kill(process.pid, result.signal);
  // If the signal was caught/ignored (e.g. exotic handlers), still fail.
  process.exit(1);
}
process.exit(result.status ?? 1);
