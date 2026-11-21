#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# Every test of the window by itself (offscreen, private tmux servers): the output
# adapter, the protocol, a native pane, widget-against-tmux parity, load and failure.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=${1:-$here/../build/mc-term}
[ -x "$bin" ] || { echo "no $bin: build it first (my-claude gui --build)" >&2; exit 1; }
for t in dialect smoke native parity stress; do
  bun "$here/$t.ts" "$bin" | tail -n 8
done
echo "host tests OK"
