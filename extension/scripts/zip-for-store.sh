#!/usr/bin/env bash
set -euo pipefail

# Repackage the WXT build output for Chrome Web Store upload.
#
# Sources from .output/chrome-mv3/ — run `pnpm build` first. The build ships
# with `manifest.key` set so every dev install resolves to the same
# deterministic extension ID. The Web Store rejects any manifest containing
# `key` ("key field is not allowed in manifest"), so this stages a copy with
# `key` removed and zips that. The build output itself is left untouched.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ext_dir="$(cd "$script_dir/.." && pwd)"
build_dir="$ext_dir/.output/chrome-mv3"
stage_dir="$ext_dir/.output/chrome-mv3-store"
zip_path="$ext_dir/.output/airglow-ext-prod.zip"

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

# Drop dev-only preview pages (planmock, announcement-preview) from the
# published artifact. They build into .output for local design work but must
# not ship to the Web Store.
for page in planmock announcement-preview; do
  rm -f "$stage_dir/$page.html"
  rm -f "$stage_dir"/chunks/"$page"-*.js
  rm -f "$stage_dir"/assets/"$page"-*.css
done

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
