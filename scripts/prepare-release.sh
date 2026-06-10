#!/usr/bin/env bash
# Bump every dif version in lockstep and prepare a release commit.
#
# The git tag is the single source of truth for a release. This script makes the
# in-tree files match a target version BEFORE you tag, so the compiled Rust
# binary (which bakes in CARGO_PKG_VERSION at build time) and the published npm
# packages all report the same number — fixing the class of bug where the npm
# wrapper was 0.4.1 but the binary still reported 0.4.0.
#
# Usage:
#   scripts/prepare-release.sh 0.4.2
#   git diff                              # review
#   git commit -am "release: v0.4.2"
#   git tag v0.4.2 && git push --follow-tags
set -euo pipefail

version="${1:?usage: prepare-release.sh <version>  (e.g. 0.4.2)}"
version="${version#v}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+].*)?$ ]]; then
  echo "error: '$version' is not a semver version" >&2
  exit 1
fi
root="$(cd "$(dirname "$0")/.." && pwd)"

echo "Bumping dif to $version ..."

# 1. Rust workspace version — drives the binary's --version via CARGO_PKG_VERSION.
#    Bumps both the [workspace.package] version and the internal dif-core dep pin.
cargo_toml="$root/cli/Cargo.toml"
VERSION="$version" perl -0pi -e 's/^version = "[^"]*"/version = "$ENV{VERSION}"/m' "$cargo_toml"
VERSION="$version" perl -0pi -e 's/(path = "crates\/dif-core", version = ")[^"]*"/$1$ENV{VERSION}"/' "$cargo_toml"

# 2. npm package versions (wrapper, sdk, react, svelte).
for pkg in cli sdk react svelte; do
  ( cd "$root/cli/packages/$pkg" && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null )
done

# 3. Regenerate the SDK source stamp from its (now-bumped) package.json.
node "$root/cli/packages/sdk/scripts/gen-version.mjs"

# 4. Refresh Cargo.lock for the workspace members (best-effort; a build fixes it too).
( cd "$root/cli" \
  && { cargo update -p dif-core --precise "$version" >/dev/null 2>&1 || true; } \
  && { cargo update -p dif-cli  --precise "$version" >/dev/null 2>&1 || true; } )

echo
echo "Done. Review with 'git diff', then:"
echo "  git commit -am 'release: v$version'"
echo "  git tag v$version && git push --follow-tags"
