#!/usr/bin/env bash
set -euo pipefail

# Repackage the WXT build for Chrome Web Store upload.
#
# The committed extension/ ships with `manifest.key` set so every dev install
# resolves to the same deterministic extension ID. The Web Store rejects any
# manifest containing `key` ("key field is not allowed in manifest"), so this
# script stages a copy of .output/chrome-mv3/ with `key` removed and zips
# that. .output/chrome-mv3/ itself is left untouched — export-extension.sh
# still ships the keyed manifest into extension/.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd "$script_dir/.." && pwd)"
build_dir="$source_dir/.output/chrome-mv3"
stage_dir="$source_dir/.output/chrome-mv3-store"
zip_path="$source_dir/.output/airglow-ext-prod.zip"

if [ ! -f "$build_dir/manifest.json" ]; then
  echo "Missing $build_dir/manifest.json — run \`pnpm build\` first." >&2
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
