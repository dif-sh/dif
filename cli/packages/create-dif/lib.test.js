import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDevArgs, cliInstallScript, detectPackageManager, execDifArgs } from "./lib.js";

test("lockfile picks the manager", () => {
  assert.equal(detectPackageManager({ files: ["pnpm-lock.yaml"] }), "pnpm");
  assert.equal(detectPackageManager({ files: ["yarn.lock"] }), "yarn");
  assert.equal(detectPackageManager({ files: ["bun.lock"] }), "bun");
  assert.equal(detectPackageManager({ files: ["bun.lockb"] }), "bun");
  assert.equal(detectPackageManager({ files: ["package-lock.json"] }), "npm");
});

test("lockfile beats user agent", () => {
  const userAgent = "npm/10.8.2 node/v22.11.0 darwin arm64 workspaces/false";
  assert.equal(detectPackageManager({ files: ["pnpm-lock.yaml"], userAgent }), "pnpm");
});

test("user agent used without lockfile", () => {
  assert.equal(detectPackageManager({ files: [], userAgent: "pnpm/9.12.0 npm/? node/v22.11.0" }), "pnpm");
  assert.equal(detectPackageManager({ files: [], userAgent: "yarn/4.5.0 npm/? node/v22.11.0" }), "yarn");
  assert.equal(detectPackageManager({ files: [], userAgent: "bun/1.1.30 npm/? node/v22.6.0" }), "bun");
});

test("defaults to npm", () => {
  assert.equal(detectPackageManager({ files: [] }), "npm");
  assert.equal(detectPackageManager({ files: [], userAgent: "garbage" }), "npm");
});

test("addDevArgs per manager", () => {
  assert.deepEqual(addDevArgs("npm", "@dif.sh/cli@0.9.0"), ["npm", "install", "-D", "@dif.sh/cli@0.9.0"]);
  assert.deepEqual(addDevArgs("pnpm", "@dif.sh/cli@0.9.0"), ["pnpm", "add", "-D", "@dif.sh/cli@0.9.0"]);
});

test("execDifArgs per manager", () => {
  assert.deepEqual(execDifArgs("npm", ["init", "--yes"]), ["npm", "exec", "--no", "--", "dif", "init", "--yes"]);
  assert.deepEqual(execDifArgs("pnpm", ["init", "--yes"]), ["pnpm", "exec", "dif", "init", "--yes"]);
  assert.deepEqual(execDifArgs("yarn", ["init", "--yes"]), ["yarn", "run", "dif", "init", "--yes"]);
  assert.deepEqual(execDifArgs("bun", ["init", "--yes"]), ["bun", "run", "dif", "init", "--yes"]);
});

test("cliInstallScript finds the installed CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "create-dif-"));
  writeFileSync(join(dir, "package.json"), "{}");
  const cli = join(dir, "node_modules", "@dif.sh", "cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "package.json"), '{"name":"@dif.sh/cli"}');
  writeFileSync(join(cli, "install.js"), "");
  assert.ok(cliInstallScript(dir).endsWith("install.js"));
});

test("cliInstallScript is null without the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "create-dif-"));
  assert.equal(cliInstallScript(dir), null);
});
