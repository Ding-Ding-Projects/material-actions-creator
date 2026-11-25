#!/usr/bin/env bash
# Re-vendors the dock panel library into public/vendor/dockview at a pinned
# version and checks the file against a known hash.
set -euo pipefail
VERSION="8.9.1"
SHA256="5f72344284be160db830a00c26abeb6e865ef29325c0abb9fa4743c9a564c2ad"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack --silent "dockview-core@$VERSION" >/dev/null 2>&1 && tar xzf dockview-core-*.tgz)
echo "$SHA256  $tmp/package/dist/dockview-core.min.js" | sha256sum -c -
mkdir -p "$ROOT/public/vendor/dockview"
cp "$tmp/package/dist/dockview-core.min.js" "$tmp/package/LICENCE.md" "$ROOT/public/vendor/dockview/"
echo "dockview-core $VERSION vendored."
