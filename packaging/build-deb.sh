#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# Build the my-claude .deb (Debian/Ubuntu, amd64) from this checkout, on the distribution
# it is for (the window links that distribution's Qt): compile the program with bun,
# build the window in a clean tree, lay out the package, dpkg-deb.
#   packaging/build-deb.sh            -> dist/deb/my-claude_<version>_amd64.deb
# Needs: bun, cmake, ninja-build, g++, qt6-base-dev, libqt6svg6-dev, libqtermwidget6-2-dev,
# libxcb1-dev, dpkg-dev.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/.." && pwd)
version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$repo/package.json" | head -1)
# Debian sorts "~" before anything: 0.0.1~alpha comes before 0.0.1
debver=${version/-/\~}
[ "$(uname -m)" = x86_64 ] || { echo "amd64 only" >&2; exit 1; }
for t in bun cmake ninja dpkg-deb dpkg-shlibdeps; do command -v $t >/dev/null || { echo "needs $t" >&2; exit 1; }; done
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
root=$work/pkg
echo "== my-claude $version (deb $debver)"
echo "== compiling the program"
mkdir -p "$root/usr/lib/my-claude" "$root/usr/bin"
(cd "$repo" && bun install --frozen-lockfile --silent && bun build --compile --target=bun-linux-x64 src/cli.ts --outfile "$root/usr/lib/my-claude/my-claude" >/dev/null)
echo "== building the window"
cmake -S "$repo/host" -B "$work/host" -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
ninja -C "$work/host" >/dev/null
install -m755 "$work/host/mc-term" "$root/usr/bin/mc-term"
echo "== laying out"
sed -e "s|@LIBDIR@|/usr/lib|g; s|@DATADIR@|/usr/share|g; s|@VERSION@|$version|g" "$here/my-claude.sh" > "$root/usr/bin/my-claude"
chmod 755 "$root/usr/bin/my-claude"
for n in 16 22 24 32 48 64 128 256 512; do install -Dm644 "$repo/host/icons/mc-term-$n.png" "$root/usr/share/icons/hicolor/${n}x${n}/apps/mc-term.png"; done
install -Dm644 "$repo/host/icons/mc-term.svg" "$root/usr/share/icons/hicolor/scalable/apps/mc-term.svg"
mkdir -p "$root/usr/share/my-claude/icons"; cp "$repo"/host/icons/mc-term.svg "$repo"/host/icons/mc-term-*.png "$root/usr/share/my-claude/icons/"
install -Dm644 "$repo/settings.example.json" "$root/usr/share/my-claude/settings.example.json"
install -Dm644 "$here/my-claude-user.service" "$root/usr/lib/systemd/user/my-claude.service"
install -Dm644 "$here/settings.json" "$root/etc/my-claude/settings.json"
install -Dm644 "$repo/README.md" "$root/usr/share/doc/my-claude/README.md"
install -Dm644 "$repo/host/PROTOCOL.md" "$root/usr/share/doc/my-claude/PROTOCOL.md"
cat > "$root/usr/share/doc/my-claude/copyright" <<COPY
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: my-claude
Source: https://github.com/JasonDictos/my-claude

Files: *
Copyright: 2026 Jason Dictos
License: MIT
Comment: /usr/bin/mc-term links qtermwidget (GPL-2.0-or-later) and is distributed under
 the GPL as a whole; /usr/lib/my-claude/my-claude carries bun and through it
 JavaScriptCore (LGPL-2.0-or-later). The source of all of it is at the address above.

License: MIT
$(sed 's/^$/./; s/^/ /' "$repo/LICENSE")
COPY
install -Dm644 /dev/stdin "$root/usr/share/applications/mc-term.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=my-claude
GenericName=Claude Code projects
Comment=Claude Code projects: one tab per project, one terminal per repo
Exec=/usr/bin/my-claude gui
TryExec=/usr/bin/my-claude
Icon=mc-term
Terminal=false
StartupNotify=true
StartupWMClass=mc-term
Categories=Development;
Keywords=claude;ai;agents;tmux;terminal;projects;
DESK
echo "== dependencies"
mkdir -p "$work/debian"; echo "Source: my-claude" > "$work/debian/control"
shlibs=$(cd "$work" && dpkg-shlibdeps -O "$root/usr/bin/mc-term" 2>/dev/null | sed -n 's/^shlibs:Depends=//p')
mkdir -p "$root/DEBIAN"
cat > "$root/DEBIAN/control" <<CTRL
Package: my-claude
Version: $debver
Architecture: amd64
Maintainer: Jason Dictos <https://github.com/JasonDictos/my-claude>
Depends: tmux (>= 3.2), git, ${shlibs}
Recommends: universal-ctags
Section: devel
Priority: optional
Homepage: https://github.com/JasonDictos/my-claude
Installed-Size: $(du -sk "$root/usr" | cut -f1)
Description: Claude Code projects: one long-lived session per repo, a tab per project
 my-claude makes a project, not a directory, the unit of work: each repo gets its own
 long-lived Claude Code session, the sessions of a project sit side by side in tmux or
 in a native window (mc-term), know about each other, and come back on the same
 conversations after a crash or a reboot. Claude Code (claude) is not part of this
 package.
CTRL
echo "/etc/my-claude/settings.json" > "$root/DEBIAN/conffiles"
mkdir -p "$repo/dist/deb"
out="$repo/dist/deb/my-claude_${debver}_amd64.deb"
dpkg-deb --root-owner-group --build "$root" "$out" >/dev/null
echo "== $(basename "$out")  ($(du -h "$out" | cut -f1))"
echo "$out"
