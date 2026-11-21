#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# The daemon: state, auto-restart, up/down through it, and its own ssh endpoint used by a
# remote window. Private tmux, private runtime dir, a throwaway key; nothing of yours.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=${MC_TERM:-$here/../host/build/mc-term}
tmp=$(mktemp -d)
cleanup() { kill $(cat "$tmp"/*.pid 2>/dev/null) 2>/dev/null || true; tmux kill-server 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
export TMUX_TMPDIR=$tmp XDG_RUNTIME_DIR=$tmp/run; unset TMUX TMUX_PANE
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export MY_CLAUDE_ROOT=$tmp/root MY_CLAUDE_CONFIG_DIR=$tmp/cfg MY_CLAUDE_CLAUDE=$here/fake-claude FAKE_CLAUDE_LOG=$tmp/claude.log HOME=$tmp/home
export MY_CLAUDE_NO_SHELL_ENV=1 MC_TERM_NO_STATE=1 MC_TERM_TEST=1 QT_QPA_PLATFORM=offscreen
mkdir -p "$MY_CLAUDE_ROOT" "$MY_CLAUDE_CONFIG_DIR" "$HOME" "$tmp/r1" "$tmp/r2"
for d in src bin node_modules package.json; do ln -s "$here/../$d" "$MY_CLAUDE_ROOT/$d"; done
port=$((20000 + RANDOM % 20000))
echo "{\"profile\":\"host\",\"peers\":{\"cli\":\"/nonexistent\"},\"autoRestart\":true,\"ssh\":{\"port\":$port,\"listen\":\"127.0.0.1\"},\"shell\":{\"login\":false}}" > "$MY_CLAUDE_CONFIG_DIR/config.json"
ssh-keygen -q -t ed25519 -N "" -f "$tmp/key" -C t; ssh-keygen -q -t ed25519 -N "" -f "$tmp/other" -C o
cp "$tmp/key.pub" "$MY_CLAUDE_CONFIG_DIR/authorized_keys"
mc() { bun "$MY_CLAUDE_ROOT/src/cli.ts" "$@"; }
fail() { echo "FAIL: $*"; echo "--- daemon log"; tail -20 "$tmp/daemon.log"; exit 1; }
sshc() { local k=$1; shift; ssh -F /dev/null -p $port -i "$k" -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o LogLevel=ERROR 127.0.0.1 "$@"; }

mc new far >/dev/null; mc add far "$tmp/r1" "$tmp/r2" >/dev/null
# bun itself in the background, not the mc function: $! would be a subshell, and the daemon would outlive the test
bun "$MY_CLAUDE_ROOT/src/cli.ts" daemon > "$tmp/daemon.log" 2>&1 & echo $! > "$tmp/daemon.pid"
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/my-claude/daemon.sock" ] && grep -q "ssh: listening" "$tmp/daemon.log" && break; sleep 0.1; done
grep -q "ssh: listening" "$tmp/daemon.log" || fail "the daemon's ssh endpoint did not come up"

# up and down go through the daemon, which keeps the record of what should run
mc up far --no-attach >/dev/null
tmux has-session -t =mc-far || fail "up through the daemon"
grep -q '"running": true' "$MY_CLAUDE_ROOT/projects/far/project.json" || fail "up should mark the project running"
# the tmux server dies: the daemon brings the project back by itself
tmux kill-server
for _ in $(seq 60); do tmux has-session -t =mc-far 2>/dev/null && break; sleep 0.25; done
tmux has-session -t =mc-far 2>/dev/null || fail "the daemon did not bring the project back"
grep -q "far is down and should be up" "$tmp/daemon.log" || fail "the daemon should say why it restarted"
# its server is in a scope of its own, not the daemon's (best effort: needs a user systemd)
mc down far >/dev/null; sleep 6
tmux has-session -t =mc-far 2>/dev/null && fail "a project brought down on purpose must stay down"
mc up far --no-attach >/dev/null

# the ssh endpoint: status for an allowed key, nothing for others, no shell
sshc "$tmp/key" status | grep -q '"name":"far"' || fail "status over ssh"
sshc "$tmp/other" status 2>/dev/null && fail "a key not in authorized_keys got in"
out=$(sshc "$tmp/key" id 2>&1 || true); echo "$out" | grep -q "nothing else" || fail "a command should be refused: $out"
sshc "$tmp/key" -N -o ExitOnForwardFailure=yes -L 127.0.0.1:$((port+1)):127.0.0.1:22 2>/dev/null & echo $! > "$tmp/fwd.pid"; sleep 1.5
timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$((port+1)) && head -c 4 <&3" 2>/dev/null | grep -q SSH && fail "a tunnel got through"
kill "$(cat "$tmp/fwd.pid")" 2>/dev/null || true; rm -f "$tmp/fwd.pid"

# a remote window through the daemon's endpoint: its driver on stdio, tmux control clients
cat > "$tmp/ssh" <<SH
#!/bin/sh
exec ssh -F /dev/null -i "$tmp/key" -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o LogLevel=ERROR "\$@"
SH
chmod +x "$tmp/ssh"
MC_TERM_SSH=$tmp/ssh "$bin" --socket "$tmp/win.sock" --remote 127.0.0.1 -p $port 2> "$tmp/win.err" & echo $! > "$tmp/win.pid"
WIN=$tmp/win.sock bun -e '
import { connect } from "node:net";
const fail = (m, x) => { console.log("FAIL:", m, JSON.stringify(x ?? "")); process.exit(1); };
for (let i = 0; i < 100 && !(await Bun.file(process.env.WIN).exists()); i++) await Bun.sleep(50);
const c = connect(process.env.WIN); let buf = "", got = [];
c.on("data", (d) => { buf += d; for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
await new Promise((r) => c.on("connect", r));
let l;
for (let i = 0; i < 150; i++) { c.write("{\"op\":\"list\"}\n"); await Bun.sleep(200); l = got.filter((x) => x.ev === "list").pop(); if (l && l.driver && l.terminals.length === 2 && l.terminals.every((t) => t.native && t.live)) break; }
if (!(l && l.terminals.length === 2 && l.terminals.every((t) => t.live))) fail("the remote window should show both panes, live", l);
c.write("{\"op\":\"quit\"}\n"); await Bun.sleep(500); process.exit(0);
' || fail "remote window through the daemon"
grep -q "ssh: 127.0.0.1: .* _gui --stdio" "$tmp/daemon.log" || fail "the driver should have come through the daemon's ssh"
grep -q "ssh: 127.0.0.1: tmux -C attach-session -t =mc-far" "$tmp/daemon.log" || fail "tmux should have come through the daemon's ssh"
echo "daemon OK"
