import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Keep this order equal to `dif init`.
// Then both tools pick the same manager.
const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager({ files, userAgent }) {
  const hit = LOCKFILES.find(([name]) => files.includes(name));
  if (hit) return hit[1];
  const name = (userAgent ?? "").split("/")[0];
  return ["pnpm", "yarn", "bun"].includes(name) ? name : "npm";
}

export function addDevArgs(pm, spec) {
  return [pm, pm === "npm" ? "install" : "add", "-D", spec];
}

export function execDifArgs(pm, args) {
  const prefix = {
    npm: ["npm", "exec", "--no", "--"],
    pnpm: ["pnpm", "exec"],
    yarn: ["yarn", "run"],
    bun: ["bun", "run"],
  }[pm];
  return [...prefix, "dif", ...args];
}

export function cliInstallScript(cwd) {
  try {
    return createRequire(join(cwd, "package.json")).resolve("@dif.sh/cli/install.js");
  } catch {
    return null;
  }
}

// A monorepo keeps its lockfile at the repo root.
// Stop at .git, so an outer folder does not count.
export function nearestFiles(cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const files = readdirSync(dir);
    if (LOCKFILES.some(([name]) => files.includes(name))) return files;
    if (files.includes(".git") || dirname(dir) === dir) return [];
  }
}
