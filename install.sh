#!/bin/sh
# Airglow installer — https://airglow.dev/install.sh
#
#   curl -fsSL https://airglow.dev/install.sh | bash
#
# Downloads the airglow host binary for this platform from the latest GitHub
# release, installs it to ~/.airglow/bin/airglow, and runs `airglow install`
# (registers the Chrome native-messaging host + seeds the workspace).
set -eu

REPO="airglow-inc/airglow-sdk"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)              asset="airglow-darwin-arm64" ;;
  Darwin-x86_64)             asset="airglow-darwin-x64" ;;
  Linux-x86_64|Linux-amd64)  asset="airglow-linux-x64" ;;
  *)
    echo "airglow: unsupported platform $(uname -s) $(uname -m) (supported: macOS arm64/x64, Linux x64)" >&2
    exit 1
    ;;
esac

command -v curl >/dev/null 2>&1 || { echo "airglow: curl is required" >&2; exit 1; }

bin_dir="${AIRGLOW_HOME:-$HOME/.airglow}/bin"
mkdir -p "$bin_dir"

# Host binaries live on host-vX.Y.Z releases; extension zips on vX.Y.Z ones.
# Pick the newest release that actually carries this platform's asset.
url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" \
  | grep -o "https://github.com/$REPO/releases/download/[^\"]*/$asset" | head -1)
if [ -z "$url" ]; then
  echo "airglow: no release with asset $asset found in $REPO" >&2
  exit 1
fi
echo "downloading $url"
tmp="$bin_dir/.airglow.download.$$"
trap 'rm -f "$tmp"' EXIT
curl -fL --progress-bar "$url" -o "$tmp"
chmod +x "$tmp"
mv -f "$tmp" "$bin_dir/airglow"
trap - EXIT

echo "installed $bin_dir/airglow ($("$bin_dir/airglow" --version))"
echo

"$bin_dir/airglow" install

echo
echo "Next step: install the Airglow extension and open its side panel —"
echo "  https://chromewebstore.google.com/detail/angbnggmaccjdinfebjoibdklmckinfb"
echo "(Already installed? It connects automatically within a few seconds.)"
echo
echo "Optional: add the CLI to your PATH:  export PATH=\"\$HOME/.airglow/bin:\$PATH\""
