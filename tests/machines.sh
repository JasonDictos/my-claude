#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# One window, two machines: this one's projects and another's ("far", reached through a
# stand-in for ssh: a second private tmux and project root), the far ones as name@far.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=${MC_TERM:-$here/../host/build/mc-term}
tmp=$(mktemp -d)
trap 'kill $(cat "$tmp"/win.pid 2>/dev/null) 2>/dev/null || true; TMUX_TMPDIR=$tmp/a tmux kill-server 2>/dev/null || true; TMUX_TMPDIR=$tmp/b tmux kill-server 2>/dev/null || true; rm -rf "$tmp"' EXIT
unset TMUX TMUX_PANE
export MY_CLAUDE_CLAUDE=$here/fake-claude FAKE_CLAUDE_LOG=$tmp/claude.log HOME=$tmp/home MY_CLAUDE_NO_SHELL_ENV=1 MC_TERM_NO_STATE=1 MC_TERM_TEST=1 QT_QPA_PLATFORM=offscreen XDG_RUNTIME_DIR=$tmp/run
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$tmp/a" "$tmp/b" "$tmp/r1" "$tmp/r2" "$tmp/r3"
for side in a b; do
  mkdir -p "$tmp/$side/root" "$tmp/$side/cfg"
  for d in src bin node_modules package.json; do ln -s "$here/../$d" "$tmp/$side/root/$d"; done
  echo '{"profile":"host","peers":{"cli":"/nonexistent"}}' > "$tmp/$side/cfg/settings.json"
done
mc() { local side=$1; shift; TMUX_TMPDIR=$tmp/$side MY_CLAUDE_ROOT=$tmp/$side/root MY_CLAUDE_CONFIG_DIR=$tmp/$side/cfg bun "$here/../src/cli.ts" "$@"; }
mc a new near >/dev/null; mc a add near "$tmp/r1" >/dev/null; mc a up near --no-attach >/dev/null
mc b new far >/dev/null; mc b add far "$tmp/r2" "$tmp/r3" >/dev/null; mc b up far --no-attach >/dev/null
# the window, this machine's driver
TMUX_TMPDIR=$tmp/a MY_CLAUDE_ROOT=$tmp/a/root MY_CLAUDE_CONFIG_DIR=$tmp/a/cfg "$bin" --socket "$tmp/win.sock" --driver "bun $here/../src/cli.ts _gui" 2> "$tmp/win.err" & echo $! > "$tmp/win.pid"
export WIN=$tmp/win.sock FAR_DRIVER="$here/fake-ssh far env TMUX_TMPDIR=$tmp/b MY_CLAUDE_ROOT=$tmp/b/root MY_CLAUDE_CONFIG_DIR=$tmp/b/cfg MY_CLAUDE_CLAUDE=$MY_CLAUDE_CLAUDE FAKE_CLAUDE_LOG=$FAKE_CLAUDE_LOG MY_CLAUDE_NO_SHELL_ENV=1 bun $here/../src/cli.ts _gui --stdio" FAR_TMUX="$here/fake-ssh far env TMUX_TMPDIR=$tmp/b tmux"
bun -e '
import { connect } from "node:net";
const env = process.env;
const fail = (m, x) => { console.log("FAIL:", m, JSON.stringify(x ?? "", null, 1)); process.exit(1); };
setTimeout(() => fail("timeout"), 90000);
for (let i = 0; i < 100 && !(await Bun.file(env.WIN).exists()); i++) await Bun.sleep(50);
const c = connect(env.WIN); let buf = "", got = [];
c.on("data", (d) => { buf += d; for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
await new Promise((r) => c.on("connect", r));
const send = (o) => c.write(JSON.stringify(o) + "\n");
const list = async () => { got = got.filter((x) => x.ev !== "list"); send({ op: "list" }); for (let i = 0; i < 200; i++) { const l = got.find((x) => x.ev === "list"); if (l) return l; await Bun.sleep(20); } };
const shows = async (what, pred, ms = 40000) => { let l; for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(250)) { l = await list(); if (pred(l)) return l; } fail(`never: ${what}`, l); };
await shows("this machine'"'"'s project", (l) => l.tabs.includes("near") && l.terminals.some((t) => t.tab === "near" && t.live));
send({ op: "connect", machine: "far", driver: env.FAR_DRIVER.split(" "), tmux: env.FAR_TMUX.split(" ") });
await shows("the far tab", (x) => x.tabs.includes("far@far"));
send({ op: "tab", tab: "far@far", focus: true }); // its panes are read from tmux once they are on screen
const l = await shows("the far project as far@far, its panes live, next to near", (x) => x.tabs.includes("near") && x.tabs.includes("far@far") && x.terminals.filter((t) => t.tab === "far@far" && t.live && t.native).length === 2);
// the far machine is a section of its own ("PROJECTS @ far"), its project under it
if (!l.nodes.some((n) => n.id === "m:far" && n.label === "PROJECTS @ far") || !l.nodes.some((n) => n.id === "p:far@far" && n.label === "far")) fail("the tree should have a far section with the far project", l.nodes);
// typing into a far pane reaches the far tmux
const fp = l.terminals.find((t) => t.tab === "far@far");
send({ op: "send", id: fp.id, text: "typed-far" });
for (let i = 0; ; i++) { send({ op: "screen", id: fp.id }); await Bun.sleep(150); const s = got.filter((x) => x.ev === "screen" && x.id === fp.id).pop(); if (s && s.text.includes("typed-far")) break; if (i > 60) fail("typing into the far pane", s); }
// the near driver still only knows near: its view of the list
send({ op: "disconnect", machine: "far" });
await shows("far gone, near still there", (x) => !x.tabs.includes("far@far") && x.tabs.includes("near"));
send({ op: "quit" }); await Bun.sleep(500); process.exit(0);
' || { echo "--- window:"; tail -5 "$tmp/win.err"; echo "--- far driver log:"; tail -8 "$HOME/.cache/my-claude/gui-driver-far.log" 2>/dev/null; exit 1; }
TMUX_TMPDIR=$tmp/b tmux has-session -t =mc-far || { echo "FAIL: the far project should still run after disconnecting"; exit 1; }
echo "machines OK"
