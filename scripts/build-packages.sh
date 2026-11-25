#!/usr/bin/env bash
# Builds self-contained Linux packages into dist/:
#   material-actions-creator_<version>_<arch>.deb
#   material-actions-creator-<version>-linux-<arch>.tar.gz
#   Material_Actions_Creator-<version>-<arch>.AppImage   (when APPIMAGETOOL points at appimagetool)
# Each one carries its own Node.js (copied from the node on PATH), the
# production dependencies and the built-in extensions, so nothing else needs
# installing. Usage: scripts/build-packages.sh [version]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="material-actions-creator"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
case "$(uname -m)" in x86_64) DEB_ARCH=amd64; ARCH=x86_64 ;; aarch64) DEB_ARCH=arm64; ARCH=aarch64 ;; *) echo "Unsupported machine: $(uname -m)" >&2; exit 1 ;; esac
DIST="$ROOT/dist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
rm -rf "$DIST"; mkdir -p "$DIST"

# ---- the application tree shared by every package ----
TREE="$WORK/tree/opt/$APP"
mkdir -p "$TREE/bin"
cp -r "$ROOT/src" "$ROOT/public" "$ROOT/extensions" "$ROOT/extension-samples" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$TREE/"
mkdir -p "$TREE/scripts"; cp "$ROOT/scripts/run-linux.sh" "$TREE/scripts/"
(cd "$TREE" && npm ci --omit=dev --no-audit --no-fund --silent)
cp "$(command -v node)" "$TREE/bin/node"
cat > "$TREE/bin/$APP" <<'WRAP'
#!/usr/bin/env bash
# Starts Material Actions Creator with the Node.js that ships in this package.
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
export PATH="$here/bin:$PATH"
export MAC_COMMIT="@COMMIT@" MAC_BUILT_AT="@BUILT_AT@"
if [ "${1:-}" = "cli" ]; then shift; exec node "$here/src/cli.js" "$@"; fi
exec "$here/scripts/run-linux.sh" "$@"
WRAP
sed -i "s|@COMMIT@|${MAC_COMMIT:-}|; s|@BUILT_AT@|${MAC_BUILT_AT:-}|" "$TREE/bin/$APP"
chmod 755 "$TREE/bin/$APP" "$TREE/bin/node" "$TREE/scripts/run-linux.sh"

desktop_entry() { # exec, icon
  printf '[Desktop Entry]\nType=Application\nName=Material Actions Creator\nComment=Run build scripts and workflows on temporary GitHub Actions repositories\nExec=%s\nIcon=%s\nTerminal=true\nCategories=Development;\n' "$1" "$2"
}

# ---- tarball ----
tar -C "$WORK/tree/opt" -czf "$DIST/$APP-$VERSION-linux-$ARCH.tar.gz" "$APP"

# ---- .deb ----
DEB="$WORK/deb"
mkdir -p "$DEB/DEBIAN" "$DEB/usr/bin" "$DEB/usr/lib/systemd/user" "$DEB/usr/share/applications" "$DEB/usr/share/icons/hicolor/scalable/apps" "$DEB/usr/share/doc/$APP"
cp -r "$WORK/tree/opt" "$DEB/opt"
ln -s "/opt/$APP/bin/$APP" "$DEB/usr/bin/$APP"
cp "$ROOT/public/icon.svg" "$DEB/usr/share/icons/hicolor/scalable/apps/$APP.svg"
cp "$ROOT/LICENSE" "$DEB/usr/share/doc/$APP/copyright"
desktop_entry "$APP" "$APP" > "$DEB/usr/share/applications/$APP.desktop"
cat > "$DEB/usr/lib/systemd/user/$APP.service" <<UNIT
[Unit]
Description=Material Actions Creator
After=network-online.target

[Service]
Type=simple
Environment=HOST=127.0.0.1
EnvironmentFile=-%h/.config/$APP/env
ExecStart=/usr/bin/$APP
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
SIZE_KB="$(du -sk "$DEB/opt" | cut -f1)"
cat > "$DEB/DEBIAN/control" <<CONTROL
Package: $APP
Version: $VERSION
Section: devel
Priority: optional
Architecture: $DEB_ARCH
Installed-Size: $SIZE_KB
Maintainer: Ding-Ding-Projects <noreply@github.com>
Homepage: https://github.com/Ding-Ding-Projects/material-actions-creator
Recommends: gh, bubblewrap
Description: Run build scripts and workflows on temporary GitHub Actions repositories
 Turns a repository's build scripts, its own workflows or a Dockerfile into a
 short-lived GitHub Actions run, hands back the outputs and deletes the
 temporary repository. Ships its own Node.js.
 Start it with "material-actions-creator", or as a service with
 "systemctl --user enable --now material-actions-creator".
CONTROL
dpkg-deb --root-owner-group --build "$DEB" "$DIST/${APP}_${VERSION}_${DEB_ARCH}.deb" >/dev/null

# ---- AppImage (optional) ----
if [ -n "${APPIMAGETOOL:-}" ]; then
  AD="$WORK/AppDir"
  mkdir -p "$AD"
  cp -r "$WORK/tree/opt" "$AD/opt"
  cp "$ROOT/public/icon.svg" "$AD/$APP.svg"
  desktop_entry "$APP" "$APP" > "$AD/$APP.desktop"
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\nexec "$APPDIR/opt/%s/bin/%s" "$@"\n' "$APP" "$APP" > "$AD/AppRun"
  chmod 755 "$AD/AppRun"
  env ARCH="$ARCH" "$APPIMAGETOOL" --no-appstream "$AD" "$DIST/Material_Actions_Creator-$VERSION-$ARCH.AppImage" >/dev/null 2>&1
fi

(cd "$DIST" && sha256sum -- * > SHA256SUMS)
ls -1 "$DIST"
