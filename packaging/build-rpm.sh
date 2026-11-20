#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# Build the my-claude RPM (Fedora, x86_64) from this checkout, locally: compile the
# program with bun, build the window (mc-term) in a clean tree, then rpmbuild.
#   packaging/build-rpm.sh            -> dist/rpm/my-claude-<version>.x86_64.rpm
# Needs: bun, cmake, ninja, gcc-c++, qt6-qtbase-devel, qt6-qtsvg-devel, qtermwidget-devel,
# rpm-build.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/.." && pwd)
version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$repo/package.json" | head -1)
[ -n "$version" ] || { echo "no version in package.json" >&2; exit 1; }
# RPM versions take no "-": 0.0.1-alpha -> Version 0.0.1, Release 0.1.alpha (sorts before 0.0.1-1)
rpm_version=${version%%-*}
pre=${version#"$rpm_version"}; pre=${pre#-}
rpm_release=${pre:+0.1.$pre}; rpm_release=${rpm_release:-1}
[ "$(uname -m)" = x86_64 ] || { echo "x86_64 only" >&2; exit 1; }
for t in bun cmake ninja rpmbuild; do command -v $t >/dev/null || { echo "needs $t" >&2; exit 1; }; done

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
stage=$work/stage; mkdir -p "$stage/icons"
echo "== my-claude $version (rpm $rpm_version-$rpm_release)"
echo "== compiling the program"
(cd "$repo" && bun install --frozen-lockfile --silent && bun build --compile --target=bun-linux-x64 src/cli.ts --outfile "$stage/my-claude" >/dev/null)
"$stage/my-claude" --version
echo "== building the window"
cmake -S "$repo/host" -B "$work/host" -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
ninja -C "$work/host" >/dev/null
cp "$work/host/mc-term" "$stage/mc-term"
echo "== staging"
sed -e "s|@LIBDIR@|/usr/lib64|g; s|@DATADIR@|/usr/share|g; s|@VERSION@|$version|g" "$here/my-claude.sh" > "$stage/my-claude.sh"
cp "$repo"/host/icons/mc-term.svg "$repo"/host/icons/mc-term-*.png "$stage/icons/"
cp "$here/my-claude-user.service" "$stage/my-claude.service"
cp "$here/settings.json" "$stage/settings.json"
cp "$repo/settings.example.json" "$repo/README.md" "$repo/LICENSE" "$repo/host/PROTOCOL.md" "$stage/"
cat > "$stage/mc-term.desktop" <<DESK
[Desktop Entry]
Type=Application
Version=1.5
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
desktop-file-validate "$stage/mc-term.desktop" 2>/dev/null || true
echo "== rpmbuild"
mkdir -p "$repo/dist/rpm"
rpmbuild -bb "$here/my-claude.spec" \
  --define "_topdir $work/rpmbuild" --define "stage $stage" \
  --define "rpm_version $rpm_version" --define "rpm_release $rpm_release" >"$work/rpmbuild.log" 2>&1 \
  || { tail -30 "$work/rpmbuild.log"; exit 1; }
rpm=$(find "$work/rpmbuild/RPMS" -name '*.rpm' | head -1)
cp "$rpm" "$repo/dist/rpm/"
echo "== $(basename "$rpm")  ($(du -h "$rpm" | cut -f1))"
echo "$repo/dist/rpm/$(basename "$rpm")"
