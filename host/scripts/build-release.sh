#!/bin/bash
# Builds release binaries for every supported platform into dist/, signs +
# notarizes the macOS ones (unsigned quarantined binaries get Gatekeeper-killed
# and trashed — the self-update brick), gzips each (the installer downloads the
# .gz — ~61 MB → ~21 MB), and writes SHA256SUMS. Checksums are computed after
# signing so they match the shipped bytes.
# Asset names match what install.sh / upload-blob.ts use:
#   airglow-{darwin-arm64,darwin-x64,linux-x64}[.gz]
#
# Signing needs the "Developer ID Application" cert in the login keychain and
# a notarytool keychain profile named "airglow" (created once via
# `xcrun notarytool store-credentials airglow ...`).
set -euo pipefail
cd "$(dirname "$0")/.."

NOTARY_PROFILE=airglow
SIGN_ID=$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')
if [ -z "$SIGN_ID" ]; then
  echo "error: no 'Developer ID Application' identity in the keychain — refusing to ship unsigned macOS binaries" >&2
  exit 1
fi

bun scripts/pack-seed.ts

targets=(darwin-arm64 darwin-x64 linux-x64)
for t in "${targets[@]}"; do
  echo "building dist/airglow-$t ..."
  bun build --compile --target="bun-$t" --outfile "dist/airglow-$t" src/main.ts
done

echo "signing macOS binaries as: $SIGN_ID"
for t in darwin-arm64 darwin-x64; do
  codesign --force --options runtime --timestamp \
    --entitlements scripts/entitlements.plist \
    --sign "$SIGN_ID" "dist/airglow-$t"
  codesign --verify --strict "dist/airglow-$t"
done

# Notarize both mach-os in one zip; Apple scans every binary inside. Bare
# executables can't be stapled, so Gatekeeper checks the ticket online.
echo "notarizing (usually 1-5 min) ..."
rm -f dist/notarize.zip
/usr/bin/zip -q -j dist/notarize.zip dist/airglow-darwin-arm64 dist/airglow-darwin-x64
notary_out=$(xcrun notarytool submit dist/notarize.zip --keychain-profile "$NOTARY_PROFILE" --wait)
echo "$notary_out"
rm -f dist/notarize.zip
if ! grep -q "status: Accepted" <<<"$notary_out"; then
  echo "error: notarization not accepted" >&2
  exit 1
fi

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
