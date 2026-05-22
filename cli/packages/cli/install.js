#!/usr/bin/env node
// postinstall — download the platform-matched dif binary from the matching
// GitHub release and place it at ./bin/dif (or dif.exe on Windows).
//
// Version is read from this package's own package.json so each published
// wrapper version pairs with exactly one binary release.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const ROOT = __dirname;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = PKG.version;
const REPO = "dif-sh/dif";
const BIN_DIR = path.join(ROOT, "bin");

const TARGETS = {
  "darwin-arm64": { archive: "dif-aarch64-apple-darwin.tar.gz", binary: "dif", ext: "tar.gz" },
  "darwin-x64":   { archive: "dif-x86_64-apple-darwin.tar.gz",  binary: "dif", ext: "tar.gz" },
  "linux-x64":    { archive: "dif-x86_64-unknown-linux-gnu.tar.gz", binary: "dif", ext: "tar.gz" },
  "linux-arm64":  { archive: "dif-aarch64-unknown-linux-gnu.tar.gz", binary: "dif", ext: "tar.gz" },
  "win32-x64":    { archive: "dif-x86_64-pc-windows-msvc.zip", binary: "dif.exe", ext: "zip" },
};

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function fail(msg) {
  console.error(`@dif.sh/cli: ${msg}`);
  process.exit(1);
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const handleResponse = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        https.get(res.headers.location, handleResponse).on("error", reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    };
    https.get(url, handleResponse).on("error", reject);
  });
}

function extract(archivePath, ext, destDir) {
  if (ext === "tar.gz") {
    // `tar` is universally available on macOS and Linux. Windows uses zip.
    execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
    return;
  }
  if (ext === "zip") {
    // PowerShell ships on Windows by default.
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`],
      { stdio: "inherit" },
    );
    return;
  }
  throw new Error(`unknown archive type: ${ext}`);
}

async function main() {
  const key = platformKey();
  const target = TARGETS[key];
  if (!target) {
    fail(
      `unsupported platform ${key}. ` +
      `Install the binary manually from https://github.com/${REPO}/releases/v${VERSION}.`,
    );
  }

  // CI / local dev path: if a pre-built binary is already provided (e.g. by
  // `cargo build` in a monorepo dev loop), skip the download entirely.
  const binaryPath = path.join(BIN_DIR, target.binary);
  if (fs.existsSync(binaryPath)) {
    process.exit(0);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${target.archive}`;
  const tmp = path.join(os.tmpdir(), `${PKG.name.replace(/[^a-z0-9]/gi, "_")}-${VERSION}.${target.ext}`);

  try {
    console.log(`@dif.sh/cli: downloading ${url}`);
    await download(url, tmp);
    extract(tmp, target.ext, BIN_DIR);
    fs.chmodSync(binaryPath, 0o755);
    console.log(`@dif.sh/cli: installed dif v${VERSION} for ${key}`);
  } catch (err) {
    fail(`installation failed: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
  }
}

main().catch((err) => fail(err.message));
