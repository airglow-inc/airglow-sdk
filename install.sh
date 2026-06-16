#!/bin/sh
# Airglow installer — https://airglow.dev/install.sh
#
#   curl -fsSL https://airglow.dev/install.sh | bash
#
# Downloads the airglow host binary for this platform from the Airglow CDN,
# installs it to ~/.airglow/bin/airglow, and runs `airglow install`
# (registers the Chrome native-messaging host + seeds the workspace).
set -eu

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
command -v gunzip >/dev/null 2>&1 || { echo "airglow: gunzip is required" >&2; exit 1; }

bin_dir="${AIRGLOW_HOME:-$HOME/.airglow}/bin"
mkdir -p "$bin_dir"

# Binaries are served gzip-compressed (~21 MB) from the Airglow CDN; the
# endpoint 302-redirects to the backing Blob store. Override the base for
# testing (e.g. a preview deploy, or a direct blob URL).
host_base="${AIRGLOW_HOST_BASE:-https://api.airglow.dev/host}"
echo "downloading airglow host ($asset)…"
tmp="$bin_dir/.airglow.download.$$"
trap 'rm -f "$tmp" "$tmp.gz"' EXIT
curl -fSL --progress-bar "$host_base/$asset.gz" -o "$tmp.gz"
gunzip -c "$tmp.gz" > "$tmp"
rm -f "$tmp.gz"
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
