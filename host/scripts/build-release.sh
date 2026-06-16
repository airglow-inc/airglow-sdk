#!/bin/bash
# Builds release binaries for every supported platform into dist/, plus
# SHA256SUMS. Asset names match what install.sh downloads from the GitHub
# release: airglow-{darwin-arm64,darwin-x64,linux-x64}.
set -euo pipefail
cd "$(dirname "$0")/.."

bun scripts/pack-seed.ts

targets=(darwin-arm64 darwin-x64 linux-x64)
for t in "${targets[@]}"; do
  echo "building dist/airglow-$t ..."
  bun build --compile --target="bun-$t" --outfile "dist/airglow-$t" src/main.ts
done

cd dist
shasum -a 256 "${targets[@]/#/airglow-}" > SHA256SUMS
echo
cat SHA256SUMS
