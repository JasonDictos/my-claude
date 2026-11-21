#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# Publish a release from this machine (no CI): build the RPM, tag, push, and make the GitHub
# release with the RPM, the .deb (built on Ubuntu: packaging/build-deb.sh) and the static
# window (packaging/static/build.sh) attached, each with its checksum.
#   packaging/release.sh             the version in package.json
#   packaging/release.sh --dry-run   build and show what would be published, publish nothing
# Notes come from packaging/notes/<version>.md (written by hand; required).
# A version with a "-" (0.0.1-alpha) is published as a pre-release.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/.." && pwd)
dry=0; [ "${1:-}" = --dry-run ] && dry=1
cd "$repo"
version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
tag="v$version"
notes="$here/notes/$version.md"
command -v gh >/dev/null || { echo "needs gh (GitHub CLI), logged in" >&2; exit 1; }
[ -f "$notes" ] || { echo "write the release notes first: $notes" >&2; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "release from main" >&2; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no | grep -v ' .claude/session.lock$' || true)" ]; then
  echo "commit first: the release is the tagged commit, not the working tree" >&2; git status --short --untracked-files=no >&2; exit 1
fi
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "$tag already exists" >&2; exit 1; }

# built elsewhere, so only checked here: the .deb (on Ubuntu) and the static window (Docker)
deb="$repo/dist/deb/my-claude_${version/-/\~}_amd64.deb"
[ -f "$deb" ] || { echo "no $deb: build it on Ubuntu (packaging/build-deb.sh)" >&2; exit 1; }
[ -x "$repo/dist/static/mc-term" ] || { echo "no dist/static/mc-term: packaging/static/build.sh" >&2; exit 1; }
out=$("$here/build-rpm.sh" | tee /dev/stderr | tail -1)
[ -f "$out" ] || { echo "no RPM built" >&2; exit 1; }
rel="$repo/dist/release"; rm -rf "$rel"; mkdir -p "$rel"
cp "$out" "$rel/"
cp "$deb" "$rel/my-claude_${version}_amd64.deb" # GitHub would mangle the "~" of Debian's name
cp "$repo/dist/static/mc-term" "$rel/mc-term-${version}-x86_64-linux"
(cd "$rel" && for f in *; do sha256sum "$f" > "$f.sha256"; done)
pre=(); [[ "$version" == *-* ]] && pre=(--prerelease)
echo "== $tag: $(cd "$rel" && ls | tr '\n' ' ')notes $notes ${pre[*]}"
if (( dry )); then echo "(dry run: nothing tagged, pushed or published)"; exit 0; fi

git tag -a "$tag" -m "my-claude $version"
git push origin main "$tag"
gh release create "$tag" "$rel"/* --title "my-claude $version" --notes-file "$notes" "${pre[@]}" --verify-tag
echo "== published: $(gh release view "$tag" --json url -q .url)"
