#!/usr/bin/env bash
set -euo pipefail

# Builds extension-source/ with WXT and refreshes the committed extension/
# directory (the ready-to-load MV3 build users get from `git pull`).
#
# extension/manifest.json is the file Chrome loads. Everything in extension/
# is generated — never edit by hand.

usage() {
  cat <<'USAGE'
Usage: scripts/export-extension.sh

Builds extension-source/ and copies the MV3 output into extension/.
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$source_dir/.." && pwd)"
build_dir="$source_dir/.output/chrome-mv3"
target_dir="$repo_root/extension"

require_file() {
  if [ ! -f "$1" ]; then echo "Missing required file: $1" >&2; exit 1; fi
}
require_dir() {
  if [ ! -d "$1" ]; then echo "Missing required directory: $1" >&2; exit 1; fi
}

require_dir "$source_dir"
require_dir "$repo_root/.git"

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required" >&2
  exit 1
fi

echo "==> Building extension-source"
(cd "$source_dir" && pnpm run build)

require_dir "$build_dir"
require_file "$build_dir/manifest.json"
require_file "$build_dir/background.js"
require_file "$build_dir/content-scripts/edge-button.js"

echo "==> Refreshing $target_dir"
mkdir -p "$target_dir"
# README.md in extension/ is hand-written install instructions for end users —
# preserve it. Everything else is replaced.
rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude 'README.md' \
  "$build_dir/" "$target_dir/"

require_file "$target_dir/manifest.json"
require_file "$target_dir/background.js"
require_file "$target_dir/content-scripts/edge-button.js"
python3 -m json.tool "$target_dir/manifest.json" >/dev/null

# Hash extension-source/ content and stamp it into manifest.json as
# `airglow_build_hash`. Chrome caches the manifest at extension load time, so
# getManifest().airglow_build_hash returns the loaded-version identity. The
# dev server compares this against the on-disk manifest to detect "you pulled
# but didn't reload"; CI compares it to catch "edited source but forgot to
# rebuild" — both use the same field. Source-based (not output-based) so the
# hash is stable across OS/toolchain differences in the build output.
BUILD_HASH="$(cd "$repo_root" && git ls-files extension-source/ | LC_ALL=C sort | xargs -I {} git hash-object {} | shasum -a 256 | awk '{print $1}')"
# Build timestamp (unix ms). Direction signal for the "git pull warranted"
# check: a manifest with a later airglow_build_ts is the one to pull. Hash
# alone can't tell which side is ahead, so a local rebuild on a branch that's
# already ahead of origin would otherwise pester the user to pull.
BUILD_TS="$(python3 -c 'import time; print(int(time.time()*1000))')"
python3 -c "
import json, sys
path = sys.argv[1]
with open(path) as f: m = json.load(f)
m['airglow_build_hash'] = sys.argv[2]
m['airglow_build_ts'] = int(sys.argv[3])
with open(path, 'w') as f: json.dump(m, f, separators=(',', ':'))
" "$target_dir/manifest.json" "$BUILD_HASH" "$BUILD_TS"

if [ -d "$target_dir/chrome-mv3" ]; then
  echo "Unexpected nested build directory: $target_dir/chrome-mv3" >&2
  exit 1
fi
if [ -d "$target_dir/entrypoints" ] || [ -f "$target_dir/package.json" ]; then
  echo "Source files leaked into ready build directory" >&2
  exit 1
fi

echo "==> Export complete"
echo "Ready extension build: $target_dir"
echo "Build hash: $BUILD_HASH"
