#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# `my-claude gui` the way the desktop's menu starts it: the session's PATH (no ~/.local/bin),
# an install without sources (the window comes ready-made), settings from older versions.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
command -v jq >/dev/null || { echo "tests/launch.sh needs jq" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export HOME=$tmp/home MY_CLAUDE_ROOT=$tmp/root MY_CLAUDE_CONFIG_DIR=$tmp/config XDG_RUNTIME_DIR=$tmp/run XDG_DATA_HOME=$tmp/share XDG_CONFIG_HOME=$tmp/home/.config DISPLAY=:99
unset WAYLAND_DISPLAY TMUX TMUX_PANE
mkdir -p "$HOME/.local/bin" "$MY_CLAUDE_ROOT/host" "$MY_CLAUDE_CONFIG_DIR" "$XDG_RUNTIME_DIR"
# the deployed layout: the program, its icons, no host/ sources
for f in src node_modules package.json; do ln -s "$here/../$f" "$MY_CLAUDE_ROOT/$f"; done
ln -s "$here/../host/icons" "$MY_CLAUDE_ROOT/host/icons"
# the window: a stand-in that writes down how it was started
printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "%s/argv"\n' "$tmp" > "$HOME/.local/bin/mc-term"
chmod +x "$HOME/.local/bin/mc-term"
bun=$(command -v bun)
mc() { env PATH=/usr/bin:/bin "$bun" "$MY_CLAUDE_ROOT/src/cli.ts" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
settings=$MY_CLAUDE_CONFIG_DIR/settings.json

# 1. found in ~/.local/bin though PATH lacks it, and started for this machine's projects
out=$(mc gui --fg 2>&1) || fail "gui: $out"
grep -qx -- --socket "$tmp/argv" || fail "not started as this machine's window: $(cat "$tmp/argv" 2>/dev/null)"

# 2. no window at all, no sources: says where the window comes from, builds nothing
if [ ! -e /usr/bin/mc-term ]; then
  mv "$HOME/.local/bin/mc-term" "$tmp/mc-term"; rm -f "$tmp/argv"
  out=$(mc gui --fg 2>&1) && fail "gui without a window succeeded: $out"
  echo "$out" | grep -q "releases" || fail "no word on where to get the window: $out"
  echo "$out" | grep -qi "cmake" && fail "tried to build without sources: $out"
  mv "$tmp/mc-term" "$HOME/.local/bin/mc-term"
fi

# 3. gui.remote (older versions: another machine's window instead of this one's) becomes a
#    machine connected to this machine's window
echo '{"gui":{"remote":"me@far","remotePort":2222}}' > "$settings"
out=$(mc gui --fg 2>&1) || fail "gui with a saved remote: $out"
grep -qx -- --remote "$tmp/argv" && fail "the saved remote still takes the window over: $(cat "$tmp/argv")"
jq -e '.gui.remote == null and .gui.remotePort == null and .gui.hosts.far.dest == "me@far" and .gui.hosts.far.port == 2222 and (.gui.connected | index("far")) != null' "$settings" >/dev/null \
  || fail "gui.remote not turned into a connected machine: $(cat "$settings")"
# an existing entry for the same machine is reused, not doubled
echo '{"gui":{"remote":"me@far","hosts":{"box":{"dest":"me@far","port":null}},"connected":[]}}' > "$settings"
mc gui --fg >/dev/null 2>&1 || fail "gui with a saved remote already in the machines"
jq -e '(.gui.hosts | keys) == ["box"] and .gui.connected == ["box"]' "$settings" >/dev/null || fail "machine doubled: $(cat "$settings")"

# 4. --install with the window already in ~/.local/bin leaves it there (not a link to itself)
mc gui --install >/dev/null 2>&1 || fail "gui --install"
[ -f "$HOME/.local/bin/mc-term" ] && [ ! -L "$HOME/.local/bin/mc-term" ] || fail "--install replaced ~/.local/bin/mc-term: $(ls -l "$HOME/.local/bin/mc-term" 2>&1)"
grep -q "^Exec=" "$XDG_DATA_HOME/applications/mc-term.desktop" || fail "no menu entry"
echo "launch OK"
