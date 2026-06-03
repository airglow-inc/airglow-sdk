#!/usr/bin/env bash
set -euo pipefail

# Installs git hooks into .git/hooks/. Per-machine, opt-in.
# Run once after cloning: bash extension-source/scripts/install-hooks.sh

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$source_dir/.." && pwd)"
hooks_dir="$repo_root/.git/hooks"

if [ ! -d "$hooks_dir" ]; then
  echo "Not a git repo (no .git/hooks): $repo_root" >&2
  exit 1
fi

cat > "$hooks_dir/pre-push" <<'HOOK'
#!/usr/bin/env bash
# Refuses the push when extension/manifest.json's airglow_build_hash doesn't
# match the source hash computed from extension-source/. Mirrors the CI check
# in .github/workflows/extension-sync.yml exactly — no rebuild, no toolchain
# dependency, no risk of build-time non-determinism tripping the diff.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
[ -d "$repo_root/extension-source" ] || exit 0
[ -f "$repo_root/extension/manifest.json" ] || exit 0

expected="$(cd "$repo_root" && git ls-files extension-source/ | LC_ALL=C sort | xargs -I {} git hash-object {} | shasum -a 256 | awk '{print $1}')"
stamped="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('airglow_build_hash',''))" "$repo_root/extension/manifest.json" 2>/dev/null || echo "")"

if [ "$expected" != "$stamped" ]; then
  echo "" >&2
  echo "ERROR: extension/ is stale relative to extension-source/." >&2
  echo "  source hash: $expected" >&2
  echo "  stamped:     ${stamped:-<missing>}" >&2
  echo "" >&2
  echo "Run: bash extension-source/scripts/export-extension.sh" >&2
  echo "Then: git add extension/ && git commit && re-push" >&2
  exit 1
fi
echo "[pre-push] extension/ ✓ (source hash $expected)"
HOOK

chmod +x "$hooks_dir/pre-push"
echo "Installed: $hooks_dir/pre-push"
