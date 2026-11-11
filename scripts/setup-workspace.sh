#!/usr/bin/env sh
# Prepares a fresh checkout or worktree: a supported Node.js and exact
# dependencies. Type checks and unit tests read package source, so no package
# build is needed afterwards.
set -e
cd "$(dirname "$0")/.."
. scripts/use-node.sh
npm ci --no-audit --no-fund
echo "Ready: Node $(node -v). Run 'npm run check:fast' to verify."
