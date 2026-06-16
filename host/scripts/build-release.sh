#!/bin/bash
# Builds release binaries for every supported platform into dist/, gzips each
# (the installer downloads the .gz — ~61 MB → ~21 MB), and writes SHA256SUMS.
# Asset names match what install.sh / upload-blob.ts use:
#   airglow-{darwin-arm64,darwin-x64,linux-x64}[.gz]
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

echo "gzipping ..."
for t in "${targets[@]}"; do
  gzip -9 -kf "airglow-$t"   # -k keeps the raw binary (needed for SHA256SUMS)
done

echo
cat SHA256SUMS
echo
ls -lh airglow-*.gz
