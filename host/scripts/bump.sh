#!/usr/bin/env bash
set -euo pipefail

# Bump the host version, commit, and tag host-vX.Y.Z. Pushing the tag triggers
# .github/workflows/host-release.yml, which cross-builds all platforms, gzips,
# and uploads them to the public Vercel Blob store (airglow-host).
# Usage (from host/): bun run bump 0.2.0
# Push stays manual:   git push && git push origin host-v0.2.0

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
host_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$host_dir/.." && pwd)"

new_version="${1:-}"
if [ -z "$new_version" ]; then
  echo "Usage: bun run bump <version>   (e.g. bun run bump 0.2.0)" >&2
  exit 1
fi
if ! [[ "$new_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must look like X.Y.Z (got: $new_version)" >&2
  exit 1
fi

tag="host-v$new_version"

cd "$repo_root"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi
if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists." >&2
  exit 1
fi

cd "$host_dir"
npm version "$new_version" --no-git-tag-version >/dev/null

cd "$repo_root"
git add host/package.json
git commit -m "[host] bump to $new_version"
git tag -a "$tag" -m "$new_version"

echo
echo "==> Bumped host to $new_version, tagged $tag."
echo "    Push to ship:  git push && git push origin $tag"
echo "    CI then builds + uploads the binaries to Vercel Blob."
echo
