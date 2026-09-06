#!/usr/bin/env bash
# Reinstall the plugin into the local DSH web profile after rebuilding.
# Usage: bash scripts/reinstall.sh
set -euo pipefail

PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "[reinstall] building $HERE/lib/ ..."
node "$HERE/scripts/build.mjs"

echo "[reinstall] refreshing $PROFILE_DIR/node_modules/dsh-ielts-examiner ..."
rm -rf "$PROFILE_DIR/node_modules/dsh-ielts-examiner"
(cd "$PROFILE_DIR" && pnpm add "file:$HERE")

echo "[reinstall] done. reload dsh web."
