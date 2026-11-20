#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# End to end for the native app: the real window (host/build/mc-term), offscreen, driven by
# the real driver against a private tmux server and a scratch project with a fake claude.
# tests/gui-e2e.ts plays the user: it raises the events a click or a key would.
# E2E_PANES=view runs it with tmux drawing each pane instead of the window being its terminal.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=${MC_TERM:-$here/../host/build/mc-term}
[ -x "$bin" ] || { echo "no $bin: build the window first (my-claude gui --build)" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'kill $(cat "$tmp"/host.pid* 2>/dev/null) 2>/dev/null || true; tmux kill-server 2>/dev/null || true; rm -rf "$tmp"' EXIT
export TMUX_TMPDIR=$tmp; unset TMUX TMUX_PANE
export MY_CLAUDE_ROOT=$tmp/root MY_CLAUDE_CLAUDE=$here/fake-claude FAKE_CLAUDE_LOG=$tmp/claude.log HOME=$tmp/home
export MY_CLAUDE_NO_SHELL_ENV=1 MC_TERM_NO_STATE=1 MC_TERM_TEST=1 QT_QPA_PLATFORM=offscreen
mkdir -p "$MY_CLAUDE_ROOT" "$HOME" "$tmp/r1" "$tmp/r2" "$tmp/r3" "$tmp/r4" "$tmp/r5" "$tmp/r6"
ln -s "$here/../src" "$MY_CLAUDE_ROOT/src"; ln -s "$here/../bin" "$MY_CLAUDE_ROOT/bin"; ln -s "$here/../node_modules" "$MY_CLAUDE_ROOT/node_modules"
export E2E_PANES=${E2E_PANES:-native}
echo "{\"profile\":\"host\",\"peers\":{\"cli\":\"/nonexistent/claude-peers-cli\"},\"gui\":{\"panes\":\"$E2E_PANES\"}}" > "$MY_CLAUDE_ROOT/config.json"
mc() { bun "$MY_CLAUDE_ROOT/src/cli.ts" "$@"; }
mc new demo --goal "the demo" >/dev/null
mc add demo "$tmp/r1" >/dev/null; mc add demo "$tmp/r2" >/dev/null
mc up demo --no-attach >/dev/null
export E2E_TMP=$tmp E2E_BIN=$bin E2E_DRIVER="bun $MY_CLAUDE_ROOT/src/cli.ts _gui"
bun "$here/gui-e2e.ts" || { echo "--- driver log:"; tail -40 "$HOME/.cache/my-claude/gui-driver.log" 2>/dev/null; exit 1; }
