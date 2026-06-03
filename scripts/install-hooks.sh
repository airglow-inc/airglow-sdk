#!/usr/bin/env bash
set -euo pipefail

# Installs git hooks into .git/hooks/. Per-machine, opt-in.
# Run once after cloning: bash scripts/install-hooks.sh

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
hooks_dir="$repo_root/.git/hooks"

if [ ! -d "$hooks_dir" ]; then
  echo "Not a git repo (no .git/hooks): $repo_root" >&2
  exit 1
fi

cat > "$hooks_dir/pre-push" <<'HOOK'
#!/usr/bin/env bash
# Refuses the push when extension/ is stale relative to extension-source/.
# Runs the export, checks for resulting diff, leaves the rebuilt extension/
# in the working tree if stale so you can commit and re-push.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
[ -d "$repo_root/extension-source" ] || exit 0

echo "[pre-push] checking extension/ is in sync with extension-source/..."
bash "$repo_root/scripts/export-extension.sh" >/dev/null

if ! git -C "$repo_root" diff --quiet -- extension/; then
  echo "" >&2
  echo "ERROR: extension/ was stale. The hook ran scripts/export-extension.sh" >&2
  echo "and the rebuild produced different output. Commit the new extension/ and re-push." >&2
  echo "" >&2
  git -C "$repo_root" diff --stat -- extension/ >&2
  exit 1
fi
echo "[pre-push] extension/ ✓"
HOOK

chmod +x "$hooks_dir/pre-push"
echo "Installed: $hooks_dir/pre-push"
