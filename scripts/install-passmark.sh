#!/usr/bin/env bash
# Install PassMark PerformanceTest for Linux from passmark.com.
#
# Usage: scripts/install-passmark.sh [destination]   (default /tmp/passmark/pt_linux)
#
# The binary links against libncurses.so.5, which Ubuntu 24.04 no longer
# ships, so it is pulled from the focal-security archive when missing.
set -euo pipefail

DEST=${1:-/tmp/passmark/pt_linux}

case "$(uname -m)" in
  x86_64) ASSET=PerformanceTest_Linux_x86-64; MIRROR=http://security.ubuntu.com/ubuntu ;;
  aarch64 | arm64) ASSET=PerformanceTest_Linux_ARM64; MIRROR=http://ports.ubuntu.com/ubuntu-ports ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if ! ldconfig -p | grep -q 'libncurses\.so\.5'; then
  list=/etc/apt/sources.list.d/focal-security.list
  echo "deb $MIRROR focal-security main universe" | sudo tee "$list" >/dev/null
  # Refresh only the focal list: faster, and a flaky third-party repo on the
  # image cannot fail the install.
  sudo apt-get update -qq \
    -o Dir::Etc::sourcelist="$list" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libncurses5 libtinfo5
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# passmark.com rejects curl's default user agent.
curl -fsSL --retry 3 --retry-all-errors -A "Mozilla/5.0 (X11; Linux $(uname -m))" \
  -o "$tmp/pt.zip" "https://www.passmark.com/downloads/${ASSET}.zip"
unzip -q -o "$tmp/pt.zip" -d "$tmp"
mkdir -p "$(dirname "$DEST")"
install -m 0755 "$tmp/PerformanceTest/${ASSET}" "$DEST"
echo "installed $ASSET to $DEST ($(sha256sum "$DEST" | cut -c1-16))"
