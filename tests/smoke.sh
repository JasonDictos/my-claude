#!/usr/bin/env bash
# Provisioning smoke test on the host profile with a fake claude:
# new/add x4/up -> 4 tiled panes with titles; --session-id first, --resume once
# a transcript exists; down kills; up recreates; add while up -> 5th pane.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'tmux kill-server 2>/dev/null || true; rm -rf "$tmp"' EXIT
# Private tmux server: panes inherit the server's environment, so it must be ours.
export TMUX_TMPDIR=$tmp; unset TMUX
export MY_CLAUDE_ROOT=$tmp/root MY_CLAUDE_CLAUDE=$here/fake-claude FAKE_CLAUDE_LOG=$tmp/claude.log HOME=$tmp/home
mkdir -p "$MY_CLAUDE_ROOT" "$HOME" "$tmp/r1" "$tmp/r2" "$tmp/r3" "$tmp/r4" "$tmp/r5"
ln -s "$here/../src" "$MY_CLAUDE_ROOT/src"; ln -s "$here/../node_modules" "$MY_CLAUDE_ROOT/node_modules"
echo '{"profile":"host","peers":{"cli":"/nonexistent/claude-peers-cli"}}' > "$MY_CLAUDE_ROOT/config.json"
mc() { bun "$MY_CLAUDE_ROOT/src/cli.ts" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
panes() { tmux list-panes -t mc-smoke:main -F '#{pane_title}' | sort | tr '\n' ' '; }
lines() { [ -f "$FAKE_CLAUDE_LOG" ] && wc -l < "$FAKE_CLAUDE_LOG" || echo 0; }
wait_log() { for _ in $(seq 75); do [ "$(lines)" -ge "$1" ] && return; sleep 0.2; done; fail "expected $1 launches, log: $(cat "$FAKE_CLAUDE_LOG" 2>/dev/null)"; }

mc new smoke --goal "test goal" >/dev/null
for i in 1 2 3 4; do mc add smoke "$tmp/r$i" >/dev/null; done
[ "$(mc status smoke --json | jq -r .lead)" = null ] || fail "nobody leads by default"
mc up smoke --no-attach >/dev/null
wait_log 4
[ "$(panes)" = "r1 r2 r3 r4 " ] || fail "panes: $(panes)"
grep -q -- "--session-id" "$FAKE_CLAUDE_LOG" || fail "first launch should use --session-id"
grep -q -- "--name smoke/r1" "$FAKE_CLAUDE_LOG" || fail "peer name missing"
st=$(mc ls --json | jq -r '.[0].state'); [[ $st = UP || $st = PARTIAL ]] || fail "ls state after up: '$st'"
mc ls | grep -q '^smoke ' || fail "ls table"
mc status smoke | grep -q '^r1 ' || fail "status table"

mc add smoke "$tmp/r5" --model opus-5.5 >/dev/null
wait_log 5
[ "$(panes)" = "r1 r2 r3 r4 r5 " ] || fail "5th pane: $(panes)"
grep -q -- "--model opus-5.5" "$FAKE_CLAUDE_LOG" || fail "model not passed"

mc lead smoke r2 "ship it" >/dev/null; [ "$(mc status smoke --json | jq -r '[.lead,.goal,.peers[0].role,.peers[1].role]|join(",")')" = "r2,ship it,peer,lead" ] || fail "lead+goal"
mc set smoke r3 --model sonnet-5.5 >/dev/null; [ "$(mc status smoke --json | jq -r '.peers[2].model')" = sonnet-5.5 ] || fail "set model"

mc down smoke >/dev/null
tmux has-session -t mc-smoke 2>/dev/null && fail "session should be gone"
[ "$(mc ls --json | jq -r '.[0].state')" = DOWN ] || fail "ls should say DOWN"

# A transcript for r1 -> its relaunch resumes by id.
sid=$(mc status smoke --json | jq -r '.peers[0].session')
tdir="$HOME/.claude/projects/$(printf '%s' "$tmp/r1" | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$tdir"; : > "$tdir/$sid.jsonl"
: > "$FAKE_CLAUDE_LOG"
mc up smoke --no-attach >/dev/null
wait_log 5
grep -q -- "$tmp/r1 --resume $sid" "$FAKE_CLAUDE_LOG" || fail "r1 should --resume $sid: $(cat "$FAKE_CLAUDE_LOG")"
grep -q -- "$tmp/r2 --session-id" "$FAKE_CLAUDE_LOG" || fail "r2 should still --session-id"

mc rm smoke r5 >/dev/null
[ "$(mc status smoke --json | jq '.peers|length')" = 4 ] || fail "rm"
mc delete smoke >/dev/null
[ "$(mc ls --json)" = "[]" ] || fail "delete"
echo "smoke OK"
