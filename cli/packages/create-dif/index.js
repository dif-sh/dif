#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addDevArgs, cliInstallScript, detectPackageManager, execDifArgs } from "./lib.js";

const cwd = process.cwd();
if (!existsSync(join(cwd, "package.json"))) {
  console.error(
    "create-dif adds dif to an existing app. Run it in your app's folder, next to package.json.",
  );
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const pm = detectPackageManager({
  files: readdirSync(cwd),
  userAgent: process.env.npm_config_user_agent,
});

// Windows starts npm, pnpm and yarn through .cmd files.
function run([cmd, ...args], shell = process.platform === "win32") {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell });
  if (result.error) {
    console.error(`create-dif: could not run ${cmd}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

console.log(`Installing @dif.sh/cli with ${pm}…`);
const added = run(addDevArgs(pm, `@dif.sh/cli@${version}`));
if (added !== 0) process.exit(added);

// pnpm 10 and bun can skip postinstall, so fetch the binary here.
const script = cliInstallScript(cwd);
if (script) {
  const fetched = run([process.execPath, script], false);
  if (fetched !== 0) process.exit(fetched);
}

process.exit(run(execDifArgs(pm, ["init", ...process.argv.slice(2)])));
