#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# The self-contained mc-term: built in Docker (Alpine, musl), everything linked in.
#   packaging/static/build.sh  -> dist/static/mc-term
# The first run builds Qt (some 15-30 minutes); later runs only mc-term.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../.." && pwd)
ctx=$(mktemp -d); trap 'rm -rf "$ctx"' EXIT
cp "$here"/Dockerfile "$here"/deps.sh "$here"/qtermwidget-static.patch "$ctx/"
cp -r "$repo/host" "$ctx/host"; rm -rf "$ctx/host/build"
docker build --target mcterm -t my-claude-static "$ctx"
mkdir -p "$repo/dist/static"
id=$(docker create my-claude-static)
docker cp "$id:/build/mc-term" "$repo/dist/static/mc-term"
docker rm -f "$id" >/dev/null
file "$repo/dist/static/mc-term"
ls -la "$repo/dist/static/mc-term"
