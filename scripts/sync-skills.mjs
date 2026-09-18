#!/usr/bin/env node
// Mirrors the Claude Code skills that `dif init` embeds (the source of truth,
// under cli/crates/dif-cli/assets/claude/skills/) into the top-level skills/
// directory, where `npx skills add dif-sh/dif` discovers them.
//
// skills/dif-docs/ is authored directly in skills/ (no crate copy) and is left
// alone. Its twin on the website, static/.well-known/agent-skills/dif-docs/
// SKILL.md in the dif-site repo, is kept in sync by hand.
//
// Usage:
//   node scripts/sync-skills.mjs          copy assets → skills/
//   node scripts/sync-skills.mjs --check  exit 1 if skills/ has drifted (CI)

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "cli", "crates", "dif-cli", "assets", "claude", "skills");
const target = join(root, "skills");
const check = process.argv.includes("--check");

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const skills = readdirSync(source).filter((name) => statSync(join(source, name)).isDirectory());
const drift = [];

for (const skill of skills) {
  const from = join(source, skill);
  const to = join(target, skill);
  const expected = listFiles(from).map((p) => relative(from, p)).sort();
  const actual = listFiles(to).map((p) => relative(to, p)).sort();

  for (const rel of new Set([...expected, ...actual])) {
    const a = join(from, rel);
    const b = join(to, rel);
    if (!existsSync(a)) drift.push(`skills/${skill}/${rel} (not in assets)`);
    else if (!existsSync(b)) drift.push(`skills/${skill}/${rel} (missing)`);
    else if (!readFileSync(a).equals(readFileSync(b))) drift.push(`skills/${skill}/${rel} (differs)`);
  }

  if (!check) {
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
}

if (check) {
  if (drift.length > 0) {
    console.error("skills/ is out of sync with cli/crates/dif-cli/assets/claude/skills/:");
    for (const line of drift) console.error(`  ${line}`);
    console.error("run: node scripts/sync-skills.mjs");
    process.exit(1);
  }
  console.log(`skills/ in sync (${skills.length} skills mirrored from assets)`);
} else {
  console.log(`mirrored ${skills.length} skills into skills/`);
}
