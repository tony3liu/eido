#!/bin/sh
set -eu
repo_root=$(git rev-parse --show-toplevel)
command -v python3 >/dev/null
git config --local core.hooksPath .githooks
chmod +x "$repo_root/.githooks/pre-commit" "$repo_root/.githooks/pre-push"
printf '%s\n' 'Eido local document guards installed.'
