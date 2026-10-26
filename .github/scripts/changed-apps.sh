#!/usr/bin/env bash
# Prints a JSON array of app folder names under apps/ that changed between two commits.
# Usage: changed-apps.sh <base> [head]
# A missing or all-zero base (new branch, first push) selects every app, and so
# does a change to the shared build files, because it can affect every app.
set -euo pipefail

base=${1:-}
head=${2:-HEAD}

all_apps() {
  find apps -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort
}

if [[ -z $base || $base =~ ^0+$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  apps=$(all_apps)
else
  files=$(git diff --name-only "$base" "$head")
  if grep -qE '^(docker-bake\.hcl|\.github/workflows/apps\.yaml|\.github/scripts/)' <<<"$files"; then
    apps=$(all_apps)
  else
    apps=$(grep -oP '^apps/\K[^/]+(?=/)' <<<"$files" | sort -u || true)
  fi
fi

# deleted apps have nothing left to build or deploy
existing=()
for app in $apps; do
  [[ -d apps/$app ]] && existing+=("$app")
done
jq -cn '$ARGS.positional' --args "${existing[@]}"
