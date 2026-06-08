#!/usr/bin/env bash
set -euo pipefail

# Repackage the exported extension/ for Chrome Web Store upload.
#
# Source from extension/ (not .output/chrome-mv3/) so the zip carries the
# airglow_build_ts and airglow_build_hash that export-extension.sh injects —
# the dashboard's "Build:" line reads airglow_build_ts off the loaded manifest
# and shows "unknown" if it's missing.
#
# extension/ ships with `manifest.key` set so every dev install resolves to
# the same deterministic extension ID. The Web Store rejects any manifest
# containing `key` ("key field is not allowed in manifest"), so this script
# stages a copy with `key` removed and zips that. extension/ itself is left
# untouched.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$source_dir/.." && pwd)"
build_dir="$repo_root/extension"
stage_dir="$source_dir/.output/chrome-mv3-store"
zip_path="$source_dir/.output/airglow-ext-prod.zip"

if [ ! -f "$build_dir/manifest.json" ]; then
  echo "Missing $build_dir/manifest.json — run \`pnpm export\` first." >&2
  exit 1
fi

rm -rf "$stage_dir"
mkdir -p "$stage_dir"
# Trailing slash → copy contents, not the directory itself. Lets us zip from
# inside $stage_dir so manifest.json lands at the zip root (the Web Store
# expects that).
rsync -a "$build_dir/" "$stage_dir/"

python3 -c "
import json, sys
p = sys.argv[1]
with open(p) as f: m = json.load(f)
if 'key' not in m:
    print('Note: manifest.json has no key field; nothing to strip.', file=sys.stderr)
m.pop('key', None)
with open(p, 'w') as f: json.dump(m, f, separators=(',', ':'))
" "$stage_dir/manifest.json"

rm -f "$zip_path"
(cd "$stage_dir" && zip -r "$zip_path" . >/dev/null)
rm -rf "$stage_dir"

echo "==> Store zip ready: $zip_path"
