#!/usr/bin/env bash
set -euo pipefail

# Bump the extension version, rebuild extension/, build the store zip, commit,
# and create a release tag.
# Usage (from extension-source/): pnpm bump 0.1.1
# Push and release-create stay manual — review the commit/tag and write the
# release notes before publishing.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$source_dir/.." && pwd)"

new_version="${1:-}"
if [ -z "$new_version" ]; then
  echo "Usage: pnpm bump <version>   (e.g. pnpm bump 0.1.1)" >&2
  exit 1
fi
if ! [[ "$new_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must look like X.Y.Z (got: $new_version)" >&2
  exit 1
fi

tag="v$new_version"

cd "$repo_root"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists." >&2
  exit 1
fi

cd "$source_dir"
pnpm version "$new_version" --no-git-tag-version >/dev/null

bash "$script_dir/export-extension.sh"
bash "$script_dir/zip-for-store.sh"

# Versioned copy for the GitHub Release asset (self-describing filename).
# The unversioned airglow-ext-prod.zip is what you upload to the Chrome Web
# Store dashboard; the versioned copy is what gets attached to the release.
release_zip="$source_dir/.output/airglow-ext-$tag.zip"
cp "$source_dir/.output/airglow-ext-prod.zip" "$release_zip"

cd "$repo_root"
git add extension-source/package.json extension/
git commit -m "[extension] bump to $new_version"
git tag -a "$tag" -m "$new_version"

echo
echo "==> Bumped to $new_version, tagged $tag."
echo "    Store zip:   extension-source/.output/airglow-ext-prod.zip   (for Web Store dashboard)"
echo "    Release zip: extension-source/.output/airglow-ext-$tag.zip   (for GH release)"
echo
echo "    Next:"
echo "      git push && git push --tags"
echo "      # then ask Claude for release notes, or:"
echo "      gh release create $tag extension-source/.output/airglow-ext-$tag.zip --notes 'your notes here'"
