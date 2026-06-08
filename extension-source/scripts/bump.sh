#!/usr/bin/env bash
set -euo pipefail

# Bump the extension version, rebuild extension/, commit, and create a release tag.
# Usage (from extension-source/): pnpm bump 0.1.1
# Push stays manual — review the commit and tag before publishing.

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

tag="ext-v$new_version"

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

cd "$repo_root"
git add extension-source/package.json extension/
git commit -m "[extension] bump to $new_version"
git tag -a "$tag" -m "$new_version"

echo
echo "==> Bumped to $new_version, tagged $tag."
echo "    Push when ready:  git push && git push --tags"
