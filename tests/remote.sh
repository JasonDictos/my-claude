#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# The window for another machine (mc-term --remote), "ssh" being tests/fake-ssh to this one:
# once as a plain login, once through the gate an allowed key gets (REMOTE_GATE=1).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=${MC_TERM:-$here/../host/build/mc-term}
[ -x "$bin" ] || { echo "no $bin: build the window first (my-claude gui --build)" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'kill $(cat "$tmp"/host.pid 2>/dev/null) 2>/dev/null || true; tmux kill-server 2>/dev/null || true; rm -rf "$tmp"' EXIT
export TMUX_TMPDIR=$tmp; unset TMUX TMUX_PANE
export MY_CLAUDE_ROOT=$tmp/root MY_CLAUDE_CLAUDE=$here/fake-claude FAKE_CLAUDE_LOG=$tmp/claude.log HOME=$tmp/home
export MY_CLAUDE_NO_SHELL_ENV=1 MC_TERM_NO_STATE=1 MC_TERM_TEST=1 QT_QPA_PLATFORM=offscreen
# REMOTE_SSH: another stand-in, or a wrapper around the real ssh to a machine that is this one
export MC_TERM_SSH=${REMOTE_SSH:-$here/fake-ssh} FAKE_SSH_LOG=$tmp/ssh.log FAKE_SSH_PIDFILE=$tmp/ssh.pid
mkdir -p "$MY_CLAUDE_ROOT" "$HOME" "$tmp/r1" "$tmp/r2"
ln -s "$here/../src" "$MY_CLAUDE_ROOT/src"; ln -s "$here/../bin" "$MY_CLAUDE_ROOT/bin"; ln -s "$here/../node_modules" "$MY_CLAUDE_ROOT/node_modules"
# "view" on purpose: a window on another machine must get native panes whatever this says
echo '{"profile":"host","peers":{"cli":"/nonexistent/claude-peers-cli"},"gui":{"panes":"view"}}' > "$MY_CLAUDE_ROOT/settings.json"
mc() { bun "$MY_CLAUDE_ROOT/src/cli.ts" "$@"; }
mc new far --goal "over there" >/dev/null
mc add far "$tmp/r1" >/dev/null; mc add far "$tmp/r2" >/dev/null
mc up far --no-attach >/dev/null
# REMOTE_AUTHORIZED_KEYS: a real sshd's keys file, given the test's key bound to the gate
# (my-claude remote allow does this for real), the gate handed this test's world.
if [ -n "${REMOTE_AUTHORIZED_KEYS:-}" ]; then
  world="env PATH=$PATH TMUX_TMPDIR=$tmp MY_CLAUDE_ROOT=$MY_CLAUDE_ROOT MY_CLAUDE_CLAUDE=$MY_CLAUDE_CLAUDE FAKE_CLAUDE_LOG=$FAKE_CLAUDE_LOG HOME=$HOME MY_CLAUDE_NO_SHELL_ENV=1"
  MY_CLAUDE_AUTHORIZED_KEYS=$tmp/ak mc remote allow "$REMOTE_KEY" --name remote-test >/dev/null
  sed "s|command=\"|command=\"$world |" "$tmp/ak" > "$REMOTE_AUTHORIZED_KEYS"
fi
export R_SOCK=$tmp/win.sock R_TMP=$tmp
# (the far side is given this test's world by hand: through a real ssh it would have none of it)
there="env TMUX_TMPDIR=$tmp MY_CLAUDE_ROOT=$MY_CLAUDE_ROOT MY_CLAUDE_CLAUDE=$MY_CLAUDE_CLAUDE FAKE_CLAUDE_LOG=$FAKE_CLAUDE_LOG HOME=$HOME MY_CLAUDE_NO_SHELL_ENV=1 bun $MY_CLAUDE_ROOT/src/cli.ts _gui"
if [ -n "${REMOTE_GATE:-}" ]; then
  # through the gate the far side gets this test's world from the environment, not the command
  export FAKE_SSH_GATE="bun $MY_CLAUDE_ROOT/src/cli.ts _remote-gate" MY_CLAUDE_NO_SHELL_ENV=1
  "$bin" --socket "$R_SOCK" --remote "${REMOTE_DEST:-test@elsewhere}" 2> "$tmp/host.err" &
else
  "$bin" --socket "$R_SOCK" --remote "${REMOTE_DEST:-test@elsewhere}" --remote-command "$there" 2> "$tmp/host.err" &
fi
echo $! > "$tmp/host.pid"
bun "$here/remote.ts" || { echo "--- ssh log:"; cat "$tmp/ssh.log" 2>/dev/null | cut -c1-200; echo "--- driver log:"; tail -20 "$HOME/.cache/my-claude/gui-driver.log" 2>/dev/null; echo "--- host:"; tail -5 "$tmp/host.err"; exit 1; }
[ -n "${REMOTE_GATE:-}" ] || REMOTE_GATE=1 "$0"
