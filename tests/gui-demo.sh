#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# The native app in a sandbox: temp HOME and projects, the host profile, a fake claude, a
# private tmux server and its own socket. Nothing of yours is touched.
#   tests/gui-demo.sh            open it and play; closing the window ends the sandbox
#   tests/gui-demo.sh shot DIR   drive it, save screenshots into DIR, quit
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/.." && pwd)
bin=${MC_TERM:-$repo/host/build/mc-term}
[ -x "$bin" ] || { echo "no $bin: build the window first (my-claude gui --build)" >&2; exit 1; }
font=$(sed -n 's/^fontFamily=//p' "$HOME/.config/qterminal.org/qterminal.ini" 2>/dev/null | head -1)
size=${MC_DEMO_FONT_SIZE:-$(sed -n 's/^fontSize=//p' "$HOME/.config/qterminal.org/qterminal.ini" 2>/dev/null | head -1)}
tmp=$(mktemp -d); trap 'tmux kill-server 2>/dev/null || true; rm -rf "$tmp"' EXIT
export TMUX_TMPDIR=$tmp; unset TMUX TMUX_PANE
export MY_CLAUDE_ROOT=$tmp/root MY_CLAUDE_CONFIG_DIR=$tmp/cfg MY_CLAUDE_CLAUDE=$here/fake-claude FAKE_CLAUDE_LOG=$tmp/claude.log FAKE_CLAUDE_SAY=$here/say HOME=$tmp/home
export MY_CLAUDE_NO_SHELL_ENV=1 MC_TERM_NO_STATE=1 MC_TERM_SOCKET=$tmp/host.sock
mkdir -p "$MY_CLAUDE_ROOT" "$MY_CLAUDE_CONFIG_DIR" "$HOME/src"
ln -s "$repo/src" "$MY_CLAUDE_ROOT/src"; ln -s "$repo/bin" "$MY_CLAUDE_ROOT/bin"; ln -s "$repo/node_modules" "$MY_CLAUDE_ROOT/node_modules"
# (plain shells: a login shell would put this machine's prompt, user and host name, in the demo)
printf '{"profile":"host","peers":{"cli":"/nonexistent"},"shell":{"login":false},"gui":{"font":"%s","fontSize":%s}}\n' "${font:-}" "${size:-0}" > "$MY_CLAUDE_CONFIG_DIR/settings.json"
for r in api web worker docs; do
  mkdir -p "$HOME/src/$r"; git -C "$HOME/src/$r" init -q -b main
  for m in "scaffold" "wire the v2 client" "review fixes"; do git -C "$HOME/src/$r" -c user.name=demo -c user.email=demo@example.com commit -q --allow-empty -m "$m"; done
done
mc() { bun "$MY_CLAUDE_ROOT/src/cli.ts" "$@"; }
mc new api-overhaul --color blue >/dev/null;  mc add api-overhaul ~/src/api ~/src/web ~/src/worker >/dev/null
mc lead api-overhaul api "Move web and worker onto the v2 API; keep the old endpoints until the worker is cut over." >/dev/null
mc new docs-refresh --color green >/dev/null; mc add docs-refresh ~/src/docs >/dev/null
mc up api-overhaul --no-attach >/dev/null

"$bin" --socket "$MC_TERM_SOCKET" --driver "bun $MY_CLAUDE_ROOT/src/cli.ts _gui" &
host=$!
if [[ "${1:-}" != shot ]]; then wait $host; exit 0; fi

out=${2:?shot needs a directory}; mkdir -p "$out"
say() { bun -e 'import { connect } from "node:net"; const c = connect(process.env.MC_TERM_SOCKET); c.on("connect", () => c.end(process.argv[1] + "\n", () => setTimeout(() => process.exit(0), 150)));' "$1"; }
grab() { say "{\"op\":\"grab\",\"path\":\"$out/$1.png\"}"; sleep 0.6; }
act() { say "{\"op\":\"emit\",\"event\":$1}"; }
for _ in $(seq 60); do [ -S "$MC_TERM_SOCKET" ] && break; sleep 0.1; done
sleep 4
mkdir -p "$MY_CLAUDE_ROOT/projects/api-overhaul/.attn"; printf ask > "$MY_CLAUDE_ROOT/projects/api-overhaul/.attn/web"; printf wait > "$MY_CLAUDE_ROOT/projects/api-overhaul/.attn/worker"
sleep 2.5; grab 1-project
act '{"ev":"action","action":"peer.shell","node":"r:api-overhaul/web"}'; sleep 3; grab 2-shell
say '{"op":"sidebar"}'; sleep 0.5; grab 3-sidebar-focus
act '{"ev":"action","action":"app.new"}'; sleep 1.2; grab 4-new-project-dialog
say '{"op":"emit","event":{"ev":"settings-open"}}'; sleep 1.2; grab 5-settings
say '{"op":"quit"}'
wait $host || true
ls -la "$out"
