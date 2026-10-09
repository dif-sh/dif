# Builds the throwaway project the screenshot tapes run in. Sourced, not run:
#
#   source assets/screenshots/setup.sh          two experiments, one exclusion group
#   source assets/screenshots/setup.sh clash    same two, exclusion_group removed
#
# Leaves the shell in a fresh temp directory, so nothing in this repo is touched.
fixture="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixture"
cd "$(mktemp -d)" && mkdir shop && cd shop || return 1
git init -q && git config user.email dev@example.com
dif init --surface checkout --events custom --agents none >/dev/null
cp "$fixture"/*.md dif/experiments/active/
if [ "${1:-}" = "clash" ]; then
  perl -ni -e 'print unless /^exclusion_group:/' dif/experiments/active/*.md
fi
