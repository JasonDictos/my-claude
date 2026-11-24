#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# Provisioning smoke test on the host profile with a fake claude:
# new/add x4/up -> 4 tiled panes with titles; --session-id first, --resume once
# a transcript exists; down kills; up recreates; add while up -> 5th pane.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
for t in tmux git jq; do command -v $t >/dev/null || { echo "tests/smoke.sh needs $t (sudo apt install $t, or dnf install $t)" >&2; exit 1; }; done
tmp=$(mktemp -d); trap 'tmux kill-server 2>/dev/null || true; rm -rf "$tmp"' EXIT
# Private tmux server: panes inherit the server's environment, so it must be ours.
export TMUX_TMPDIR=$tmp; unset TMUX
export MY_CLAUDE_ROOT=$tmp/root MY_CLAUDE_CLAUDE=$here/fake-claude FAKE_CLAUDE_LOG=$tmp/claude.log HOME=$tmp/home
mkdir -p "$MY_CLAUDE_ROOT" "$HOME" "$tmp/r1" "$tmp/r2" "$tmp/r3" "$tmp/r4" "$tmp/r5" "$tmp/r6" "$tmp/r7"
ln -s "$here/../src" "$MY_CLAUDE_ROOT/src"; ln -s "$here/../bin" "$MY_CLAUDE_ROOT/bin"; ln -s "$here/../node_modules" "$MY_CLAUDE_ROOT/node_modules"; ln -s "$here/../skills" "$MY_CLAUDE_ROOT/skills"
echo '{"profile":"host","peers":{"cli":"/nonexistent/claude-peers-cli"}}' > "$MY_CLAUDE_ROOT/config.json"
mc() { bun "$MY_CLAUDE_ROOT/src/cli.ts" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
bun "$here/gate.ts" >/dev/null || fail "the ssh gate (tests/gate.ts)"
# An agent's state from its hooks: working, asking, done; an interrupted or dead turn goes idle.
hooks=$(bun -e 'const a = await import(process.argv[1]); console.log(a.attentionSettings("hk", "r"));' "$MY_CLAUDE_ROOT/src/attention.ts")
hook() { jq -r --arg e "$1" --arg m "${2:-}" '.hooks[$e][]? | select($m == "" or ((.matcher // "") | test($m))) | .hooks[].command' <<<"$hooks"; }
run_hook() { local c; c=$(hook "$@"); [ -n "$c" ] || fail "no $1 ${2:-}hook"; sh -c "$c"; }
state() { cat "$MY_CLAUDE_ROOT/projects/hk/.attn/r" 2>/dev/null || echo none; }
check() { [ "$(state)" = "$1" ] || fail "after $2 the state is $(state), not $1"; }
run_hook UserPromptSubmit; check work "a prompt"
run_hook Notification permission_prompt; check ask "a permission prompt"
run_hook PostToolUse; check work "the tool ran"
run_hook Stop; check wait "the turn ended"
run_hook Notification idle_prompt; check wait "idling after a finished turn"
run_hook UserPromptSubmit; run_hook Notification idle_prompt; check none "idling after an interrupted turn"
run_hook UserPromptSubmit; run_hook SessionStart resume; check none "a new session after a dead one"
run_hook UserPromptSubmit; [ -z "$(hook SessionStart compact)" ] || fail "a compaction mid-turn must not end the work"
rm -rf "$MY_CLAUDE_ROOT/projects/hk"
# A Claude busy right now says so on its last line ("esc to interrupt"), hooks or not; the same
# words higher up, in what it wrote, are not its footer.
tmux new-session -d -s busytest -x 120 -y 20 "printf 'said esc to interrupt before\n\n> \n  bypass permissions on · esc to interrupt\n'; sleep 600"
tmux new-window -d -t busytest "printf 'I mention esc to interrupt here\nmore\nlines\n\n> \n  bypass permissions on (shift+tab to cycle)\n'; sleep 600"
# a crowded footer leaves "esc to interrupt" out: the spinner line above the input box says it
tmux new-window -d -t busytest "printf '  44    SECTION(\\\"unknown\\\") {\n* Unraveling… (1m 9s · ↓ 7.2k tokens · thinking with xhigh effort)\n   ◎ /goal active (16h)\n──────\n❯ \n──────\n  ~/webapp · Opus 5.5 [docker]\n  bypass permissions on (shift+tab to cycle) · PR #123 · 2 feedback drafts\n'; sleep 600"
# and a finished turn's summary is no spinner
tmux new-window -d -t busytest "printf '✻ Worked for 1m 2s\n──────\n❯ \n──────\n  ~/x · Opus 5.5\n  bypass permissions on (shift+tab to cycle)\n'; sleep 600"
sleep 0.5
mapfile -t bp < <(tmux list-panes -s -t =busytest -F '#{pane_id}')
busy=$(bun -e 'const t = await import(process.argv[1]); console.log([...await t.busy(process.argv.slice(2))].sort().join(","));' "$MY_CLAUDE_ROOT/src/tmux.ts" "${bp[@]}")
want=$(printf '%s\n' "${bp[0]}" "${bp[2]}" | sort | paste -sd,)
[ "$busy" = "$want" ] || fail "busy panes: '$busy', want $want (of ${bp[*]}: footer, mention, spinner, finished)"
tmux kill-session -t =busytest
panes() { tmux list-panes -s -t mc-smoke -F '#{pane_title}' | grep -v '^my-claude-panel$' | sort | tr '\n' ' '; }
panel() { tmux list-panes -t mc-smoke:1 -F '#{pane_title} #{pane_left} #{pane_width}' | grep '^my-claude-panel '; }
wins() { tmux list-windows -t mc-smoke -F '#{window_index}' | wc -l; }
panels() { tmux list-panes -s -t mc-smoke -F '#{pane_title}' | grep -c '^my-claude-panel$'; }
lines() { [ -f "$FAKE_CLAUDE_LOG" ] && wc -l < "$FAKE_CLAUDE_LOG" || echo 0; }
wait_log() { for _ in $(seq 75); do [ "$(lines)" -ge "$1" ] && return; sleep 0.2; done; fail "expected $1 launches, log: $(cat "$FAKE_CLAUDE_LOG" 2>/dev/null)"; }

mc new smoke --goal "test goal" >/dev/null
for i in 1 2 3 4; do mc add smoke "$tmp/r$i" >/dev/null; done
# a folder belongs to one project: a second one cannot take it (two Claudes on one conversation)
mc new twin >/dev/null
out=$(mc add twin "$tmp/r1" 2>&1) && fail "a second project took r1: $out"
echo "$out" | grep -q "already r1 in project smoke" || fail "the refusal should name the project: $out"
mc delete twin >/dev/null
[ "$(mc status smoke --json | jq -r .lead)" = null ] || fail "nobody leads by default"
mc up smoke --no-attach >/dev/null
wait_log 4
[ "$(panes)" = "r1 r2 r3 r4 " ] || fail "panes: $(panes)"
[ "$(panel)" = "my-claude-panel 0 30" ] || fail "side panel missing or not a 30-col left column: $(panel)"
grep -q -- "--session-id" "$FAKE_CLAUDE_LOG" || fail "first launch should use --session-id"
grep -q -- "--name smoke/r1" "$FAKE_CLAUDE_LOG" || fail "peer name missing"
grep -q 'review <path>' "$FAKE_CLAUDE_LOG" || fail "the brief should tell agents about plan review"
# my-claude's skills, linked (not copied) where Claude looks for the user's
env -u CLAUDE_CONFIG_DIR bun "$MY_CLAUDE_ROOT/src/cli.ts" install --skills >/dev/null || fail "install --skills"
for s in review-plan plan-review; do
  [ -L "$HOME/.claude/skills/$s" ] && [ "$(readlink "$HOME/.claude/skills/$s")" = "$MY_CLAUDE_ROOT/skills/$s" ] || fail "install --skills should link $s"
done
env -u CLAUDE_CONFIG_DIR bun "$MY_CLAUDE_ROOT/src/cli.ts" install --skills >/dev/null || fail "install --skills twice"
st=$(mc ls --json | jq -r '.[0].state'); [[ $st = UP || $st = PARTIAL ]] || fail "ls state after up: '$st'"
mc ls | grep -q '^smoke ' || fail "ls table"
mc status smoke | grep -q '^r1 ' || fail "status table"

# A big float in front (a shell) must not become the split target: the new peer stays docked.
# (floating panes are tmux 3.8's; older ones just add the peer)
if tmux -V | grep -qE 'tmux (next-)?(3\.([89]|[1-9][0-9])|[4-9])'; then
  tmux new-pane -d -t mc-smoke -T shell:r1 -x 90% -y 90% sleep 300
  mc add smoke "$tmp/r5" --model opus-5.5 >/dev/null
  wait_log 5
  [ "$(tmux list-panes -s -t mc-smoke -F '#{pane_title} #{?pane_floating_flag,1,0}' | grep '^r5 ')" = "r5 0" ] || fail "peer added over a float must be docked"
  tmux kill-pane -t "$(tmux list-panes -s -t mc-smoke -F '#{pane_id} #{pane_title}' | awk '$2=="shell:r1"{print $1}')"
else
  mc add smoke "$tmp/r5" --model opus-5.5 >/dev/null
  wait_log 5
fi
[ "$(panes)" = "r1 r2 r3 r4 r5 " ] || fail "5th pane: $(panes)"
[ "$(wins)" = 1 ] || fail "5 peers should still be one window, got $(wins)"
# Spill: the 7th peer opens a second window (tab) with its own panel; removing it closes the tab.
mc add smoke "$tmp/r6" >/dev/null; mc add smoke "$tmp/r7" >/dev/null; wait_log 7
[ "$(wins)" = 2 ] || fail "7 peers should spill into 2 windows, got $(wins)"
[ "$(panels)" = 2 ] || fail "each window needs a panel, got $(panels)"
[ "$(tmux list-panes -t mc-smoke:2 -F '#{pane_title}' | grep -v panel)" = "r7" ] || fail "r7 should be alone in window 2"
mc rm smoke r7 >/dev/null; sleep 1
[ "$(wins)" = 1 ] || fail "empty tab should close, got $(wins)"
mc rm smoke r6 >/dev/null
grep -q -- "--model opus-5.5" "$FAKE_CLAUDE_LOG" || fail "model not passed"

mc lead smoke r2 "ship it" >/dev/null; [ "$(mc status smoke --json | jq -r '[.lead,.goal,.peers[0].role,.peers[1].role]|join(",")')" = "r2,ship it,peer,lead" ] || fail "lead+goal"
mc set smoke r3 --model sonnet-5.5 >/dev/null; [ "$(mc status smoke --json | jq -r '.peers[2].model')" = sonnet-5.5 ] || fail "set model"
# A project's colour: one of the names, or any #rrggbb
mc color smoke "#336699" >/dev/null || fail "a #rrggbb colour should be taken"
[ "$(jq -r .color "$MY_CLAUDE_ROOT/projects/smoke/project.json")" = "#336699" ] || fail "the colour should be recorded"
mc color smoke "#33669" >/dev/null 2>&1 && fail "a malformed colour should be refused"
mc color smoke blue >/dev/null || fail "a named colour still works"
# An agent asks the window to show a plan: the request waits in the project's folder.
mkdir -p "$tmp/r1/docs"; echo "# plan" > "$tmp/r1/docs/plan.md"
(cd "$tmp/r1" && MY_CLAUDE_PROJECT=smoke MY_CLAUDE_PEER=r1 mc review docs/plan.md >/dev/null) || fail "review should take a plan"
[ "$(cat "$MY_CLAUDE_ROOT/projects/smoke/.review/r1")" = "$tmp/r1/docs/plan.md" ] || fail "review should leave the plan's path for the window"
(cd "$tmp/r1" && MY_CLAUDE_PROJECT=smoke MY_CLAUDE_PEER=r1 mc review docs/nope.md >/dev/null 2>&1) && fail "review of a missing file should fail"
(cd "$tmp/r1" && unset MY_CLAUDE_PROJECT MY_CLAUDE_PEER && mc review docs/plan.md >/dev/null 2>&1) && fail "review outside an agent should fail"
rm -rf "$MY_CLAUDE_ROOT/projects/smoke/.review"

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

# Symbol index: ctags over each peer at launch, into projects/<p>/.my-claude/<repo>/tags; rebuildable by hand.
if command -v ctags >/dev/null; then # without it there is simply no index
  printf 'int smoke_fn(int a) { return a; }\n' > "$tmp/r1/smoke.c"
  mc index smoke r1 >/dev/null || fail "index"
  grep -q -P '^smoke_fn\t' "$MY_CLAUDE_ROOT/projects/smoke/.my-claude/r1/tags" || fail "index should hold smoke_fn"
  grep -q 'smoke_fn.*signature:(int a)' "$MY_CLAUDE_ROOT/projects/smoke/.my-claude/r1/tags" || fail "index should carry signatures"
  [ "$(mc index smoke | wc -l)" = 5 ] || fail "index with no repo indexes every peer"
  grep -q -- "Symbol index: $MY_CLAUDE_ROOT/projects/smoke/.my-claude/r1/tags" "$FAKE_CLAUDE_LOG" || fail "brief should name the index"
fi
# Ticket: set, shown, briefed, cleared.
mc ticket smoke abc-77 | grep -q 'ABC-77' || fail "ticket set"
[ "$(mc ticket smoke)" = ABC-77 ] || fail "ticket get"
[ "$(mc status smoke --json | jq -r .ticket)" = ABC-77 ] || fail "ticket in status"
mc ticket smoke nonsense 2>/dev/null && fail "a bad key must be refused"
mc ticket smoke - >/dev/null; [ "$(mc ticket smoke)" = "-" ] || fail "ticket clear"

# prefix+x on a peer pane = remove the peer; on a shell pane = just close it.
pid=$(tmux list-panes -s -t mc-smoke -F '#{pane_id} #{pane_title}' | awk '$2=="r4"{print $1}')
mc _close "$pid" | grep -q '^removed r4' || fail "_close on a peer pane should remove it"
[ "$(mc status smoke --json | jq '.peers|length')" = 4 ] || fail "r4 should be gone from the record"
[ "$(panes)" = "r1 r2 r3 r5 " ] || fail "r4 pane should be gone: $(panes)"
mc add smoke "$tmp/r4" >/dev/null; wait_log 6

sid5=$(mc status smoke --json | jq -r '.peers[]|select(.repo=="r5").session')
mc rm smoke r5 >/dev/null
[ "$(mc status smoke --json | jq '.peers|length')" = 4 ] || fail "rm"
mc readd smoke | grep -q '^r5 ' || fail "readd should list r5 as removed"
mc readd smoke r5 >/dev/null || fail "readd"
[ "$(mc status smoke --json | jq -r '.peers[]|select(.repo=="r5").session')" = "$sid5" ] || fail "readd must keep the conversation"
wait_log 7

# Exact session names: a project whose name starts another's is not up because that one is.
mc new smo >/dev/null; mc add smo "$tmp/r6" >/dev/null
[ "$(mc status smo --json | jq -r .state)" = DOWN ] || fail "smo must not pass for smoke (session prefix match)"
mc down smo | grep -q 'already down' || fail "down smo must not touch smoke"
tmux has-session -t '=mc-smoke' || fail "smoke must survive 'down smo'"
mc delete smo >/dev/null
tmux show-hooks -g | grep -q '_tile' || fail "layout hooks not installed: $(tmux show-hooks -g | head -3)"
# tmux's scrollback is memory: my-claude's panes get a bound, the server's own default is left as it was.
r1p=$(tmux list-panes -s -t '=mc-smoke' -F '#{pane_id} #{pane_title}' | awk '$2=="r1"{print $1}')
[ "$(tmux display-message -p -t "$r1p" '#{history_limit}')" = 50000 ] || fail "a pane should get the bounded history, got $(tmux display-message -p -t "$r1p" '#{history_limit}')"
[ "$(tmux show-options -gv history-limit)" = 2000 ] || fail "the global history limit must be put back, is $(tmux show-options -gv history-limit)"

# Layouts. solo: every pane a window of its own and no panel (what the native app shows),
# shells are tagged windows; grid packs everything back behind the panel.
mc layout smoke solo >/dev/null
[ "$(mc layout smoke)" = solo ] || fail "layout not recorded"
[ "$(panels)" = 0 ] || fail "solo keeps no panel, got $(panels)"
[ "$(wins)" = 5 ] || fail "solo: one window per peer, got $(wins)"
[ "$(tmux list-windows -t mc-smoke -F '#{window_panes}' | sort -u)" = 1 ] || fail "solo: one pane per window"
[ "$(panes)" = "r1 r2 r3 r4 r5 " ] || fail "solo lost a pane: $(panes)"
sh1=$(bun -e 'const c = await import(process.argv[1]); console.log(await c.openShell("smoke", "r1"));' "$MY_CLAUDE_ROOT/src/core.ts")
[ "$(tmux display-message -p -t "$sh1" '#{@mc_role} #{?pane_floating_flag,1,0}')" = "shell:r1 0" ] || fail "solo shell should be a tagged window: $sh1"
[ "$(wins)" = 6 ] || fail "solo shell should be its own window, got $(wins)"
# A shell whose program renames it after its repo is still a shell: closing it never costs the peer.
tmux select-pane -t "$sh1" -T r1
mc _close "$sh1" | grep -q '^closed' || fail "_close on a retitled shell must only close it"
[ "$(mc status smoke --json | jq '.peers|length')" = 5 ] || fail "a retitled shell cost a peer"
mc add smoke "$tmp/r6" >/dev/null; wait_log 8
[ "$(wins)" = 6 ] && [ "$(panels)" = 0 ] || fail "a peer added in solo gets its own window and no panel: $(wins) windows, $(panels) panels"

# A view (what one pane of the native app runs): a grouped session on that pane's window
# with no status bar, which ends the moment its window changes.
p2=$(tmux list-panes -s -t '=mc-smoke' -F '#{pane_id} #{pane_title}' | awk '$2=="r2"{print $1}')
v="mcv-smoke-${p2#%}"
view() { script -qfc "bun $MY_CLAUDE_ROOT/src/cli.ts _view smoke $p2" /dev/null >/dev/null 2>&1 & for _ in $(seq 50); do tmux has-session -t "=$v" 2>/dev/null && return; sleep 0.1; done; fail "view session did not start"; }
if tmux -V | grep -qE 'tmux (next-)?(3\.([89]|[1-9][0-9])|[4-9])'; then # (the view fallback is not tested before tmux 3.8)
  view
  got=$(tmux display-message -p -t "=$v:" '#{session_group} #{status} #{pane_id}')
  [ "$got" = "mc-smoke off $p2" ] || fail "view should show r2's window without a status bar: $got"
  [ "$(mc ls --json | jq -r '.[] | select(.name=="smoke") | .state')" != DOWN ] || fail "ls with a view attached"
  [ "$(mc status smoke --json | jq '.peers|length')" = 6 ] || fail "status with a view attached"
  tmux select-window -t "=$v:+1"; sleep 0.6
  tmux has-session -t "=$v" 2>/dev/null && fail "a view that changed window must end"
fi

mc layout smoke grid >/dev/null
[ "$(mc layout smoke)" = grid ] || fail "grid not recorded"
[ "$(wins)" = 1 ] || fail "grid should pack 6 panes into one window, got $(wins)"
[ "$(panels)" = 1 ] || fail "grid brings the panel back, got $(panels)"
[ "$(panes)" = "r1 r2 r3 r4 r5 r6 " ] || fail "grid lost a pane: $(panes)"
mc rm smoke r6 >/dev/null
# Chat pane: the user joins the group for as long as it runs, typed lines go to the group.
echo "{\"profile\":\"host\",\"peers\":{\"cli\":\"$here/fake-peers\"},\"chat\":{\"name\":\"tester\"}}" > "$MY_CLAUDE_ROOT/config.json"
export FAKE_PEERS_LOG=$tmp/peers.log
printf 'hello all\n' | mc _chat smoke >/dev/null
grep -q '^group mc-smoke .* tester$' "$FAKE_PEERS_LOG" || fail "chat should add tester to the group: $(cat "$FAKE_PEERS_LOG")"
grep -q '^broadcast mc-smoke .*tester (the user) joined' "$FAKE_PEERS_LOG" || fail "chat should announce the join"
grep -q '^chat mc-smoke --name tester --cwd ' "$FAKE_PEERS_LOG" || fail "chat should run the peers chat"
grep -q '^broadcast my-claude-app$' "$FAKE_PEERS_LOG.from" || fail "my-claude's notes should be signed by my-claude itself, not the session it runs under: $(cat "$FAKE_PEERS_LOG.from")"
grep -q '^chat -$' "$FAKE_PEERS_LOG.from" || fail "the user's chat speaks as the user"
grep -q '^send mc-smoke hello all$' "$FAKE_PEERS_LOG" || fail "typed line should reach the group"
tail -1 "$FAKE_PEERS_LOG" | grep -q '^group mc-smoke ' && ! tail -1 "$FAKE_PEERS_LOG" | grep -q ' tester$' || fail "leaving should drop tester from the group: $(tail -1 "$FAKE_PEERS_LOG")"
[ -e "$MY_CLAUDE_ROOT/projects/smoke/.my-claude/chat.json" ] && fail "chat marker left behind"
grep -q 'claude-peers peer "' "$FAKE_CLAUDE_LOG" || fail "brief should name the chat peer"  # launched before chat.name was set: any name
# A Claude on another conversation in a peer's folder (one started by hand in ~, say; Claude
# Code says which in ~/.claude/sessions/<pid>.json) is not the peer's: restart leaves it running.
(cd "$tmp/r2" && exec "$MY_CLAUDE_CLAUDE" --resume elsewhere) >/dev/null 2>&1 & other=$!
# (set -e holds in the trap too: a pkill that finds nothing would end it before the cleanup)
trap 'pkill -P "$other" 2>/dev/null || true; kill "$other" 2>/dev/null || true; tmux kill-server 2>/dev/null || true; rm -rf "$tmp"' EXIT
sleep 0.3
mkdir -p "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"
start=$(cut -d')' -f2- "/proc/$other/stat" | awk '{print $20}')
echo "{\"pid\":$other,\"sessionId\":\"not-r2\",\"name\":\"\",\"procStart\":\"$start\"}" > "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions/$other.json"
mc restart smoke r2 >/dev/null || fail "restart r2 with a Claude on another conversation in its folder"
kill -0 "$other" 2>/dev/null || fail "restart stopped a Claude on another conversation in r2's folder"
[ "$(mc status smoke --json | jq -r '.peers[]|select(.repo=="r2").state')" = live ] || fail "r2 not live after restart: $(mc status smoke | grep '^r2 ')"
pkill -P "$other"; kill "$other"
# A repo added is in the project's group and the group told, before the command is done; also
# from the compiled binary (what a peer's MCP server runs in a container).
mkdir -p "$tmp/r9" "$tmp/r10"; : > "$FAKE_PEERS_LOG"
mc add smoke "$tmp/r9" >/dev/null
grep -q "^group mc-smoke .*$tmp/r9" "$FAKE_PEERS_LOG" || fail "adding r9 should put it in the group: $(cat "$FAKE_PEERS_LOG")"
grep -q '^broadcast mc-smoke .*r9 joined' "$FAKE_PEERS_LOG" || fail "adding r9 should tell the group: $(cat "$FAKE_PEERS_LOG")"
bun build --compile "$here/../src/cli.ts" --outfile "$tmp/mc-bin" >/dev/null
: > "$FAKE_PEERS_LOG"
"$tmp/mc-bin" add smoke "$tmp/r10" >/dev/null
grep -q "^group mc-smoke .*$tmp/r10" "$FAKE_PEERS_LOG" || fail "the compiled binary should put r10 in the group too: $(cat "$FAKE_PEERS_LOG")"
grep -q '^broadcast mc-smoke .*r10 joined' "$FAKE_PEERS_LOG" || fail "the compiled binary should tell the group too: $(cat "$FAKE_PEERS_LOG")"
mc rm smoke r9 >/dev/null; mc rm smoke r10 >/dev/null
echo '{"profile":"host","peers":{"cli":"/nonexistent/claude-peers-cli"}}' > "$MY_CLAUDE_ROOT/config.json"
mc rm smoke r5 >/dev/null
cp "$MY_CLAUDE_ROOT/projects/smoke/project.json" "$tmp/smoke.json"
# Bringing a project down takes its views with it: they share its windows and would keep the peers alive.
p2=$(tmux list-panes -s -t '=mc-smoke' -F '#{pane_id} #{pane_title}' | awk '$2=="r2"{print $1}'); v="mcv-smoke-${p2#%}"
if tmux -V | grep -qE 'tmux (next-)?(3\.([89]|[1-9][0-9])|[4-9])'; then view; fi
mc delete smoke >/dev/null
tmux list-sessions -F '#S' 2>/dev/null | grep -q smoke && fail "sessions left after delete: $(tmux list-sessions -F '#S' | tr '\n' ' ')"
[ "$(mc ls --json)" = "[]" ] || fail "delete"
mc undelete | grep -q '^smoke ' || fail "undelete should list the trashed project"
mc undelete smoke >/dev/null || fail "undelete"
cmp -s "$tmp/smoke.json" "$MY_CLAUDE_ROOT/projects/smoke/project.json" || fail "undelete must restore the record (paths, session ids) unchanged"
mc delete smoke >/dev/null
# A project started with a work order (the MCP tool): the lead takes it as its first prompt.
mkdir -p "$tmp/r8"; n=$(lines)
bun -e 'const c = await import(process.argv[1]); await c.startProject({ name: "kick", repos: [process.argv[2]], workOrder: "do the kick work" });' "$MY_CLAUDE_ROOT/src/core.ts" "$tmp/r8" >/dev/null
wait_log $((n + 1))
tail -1 "$FAKE_CLAUDE_LOG" | grep -q ' do the kick work$' || fail "the lead's first prompt: $(tail -1 "$FAKE_CLAUDE_LOG")"
mc delete kick >/dev/null
# Removing means deleting: a clone goes from disk, a repo linked from elsewhere is only unlinked.
# Nothing goes without --force while it would lose something: changes, commits, stashes, a non-repo.
git init -q -b main "$tmp/upstream" && git -C "$tmp/upstream" -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
git clone -q --bare "$tmp/upstream" "$tmp/origin.git"
mkdir -p "$tmp/linked"; mc new del >/dev/null
mc add del "file://$tmp/origin.git" >/dev/null; mc add del "$tmp/linked" >/dev/null
clone=$MY_CLAUDE_ROOT/projects/del/origin
[ -d "$clone/.git" ] || fail "no clone at $clone"
touch "$clone/new-file"
out=$(mc rm del origin 2>&1) && fail "removed a clone with an uncommitted file: $out"
echo "$out" | grep -q "1 uncommitted file" || fail "should say what would be lost: $out"
rm "$clone/new-file"; git -C "$clone" -c user.name=t -c user.email=t@t commit -q --allow-empty -m mine
out=$(mc rm del origin 2>&1) && fail "removed a clone with an unpushed commit: $out"
echo "$out" | grep -q "1 unpushed commit" || fail "should say what would be lost: $out"
git -C "$clone" push -q origin HEAD
# a rebased (here: amended) copy of pushed work is no loss; a branch never pushed is, by name
g() { git -C "$clone" -c user.name=t -c user.email=t@t "$@"; }
g checkout -q -b topic; echo t > "$clone/t"; g add t; g commit -q -m t1; g push -q -u origin topic; g commit -q --amend -m "t1 reworded"
g checkout -q main; g checkout -q -b scratch; echo w > "$clone/w"; g add w; g commit -q -m wip; g checkout -q main
out=$(mc rm del origin 2>&1) && fail "removed a clone with a branch never pushed: $out"
echo "$out" | grep -q "1 unpushed commit on scratch" || fail "should name the branch: $out"
echo "$out" | grep -q "topic" && fail "a rebased copy of pushed work is no loss: $out"
g branch -q -D scratch
mc rm del origin >/dev/null || fail "a clean, pushed clone should go without --force"
[ -e "$clone" ] && fail "the removed clone is still on disk"
mc rm del linked >/dev/null; [ -d "$tmp/linked" ] || fail "a linked repo must never be deleted"
# the project: a stray folder in it is no repo, so it takes --force; the record stays for undelete
mc add del "file://$tmp/origin.git" >/dev/null; mkdir -p "$MY_CLAUDE_ROOT/projects/del/notes"; echo x > "$MY_CLAUDE_ROOT/projects/del/notes/todo"
mkdir -p "$MY_CLAUDE_ROOT/projects/del/.attn"
out=$(mc delete del 2>&1) && fail "deleted a project holding a folder that is no repo: $out"
echo "$out" | grep -q "notes: not a git repo" || fail "should name the folder: $out"
echo "$out" | grep -q "\.attn" && fail "my-claude's own folders are no clones: $out"
mc delete del --force >/dev/null || fail "delete --force"
[ -e "$MY_CLAUDE_ROOT/projects/del" ] && fail "the project is still on disk"
[ -n "$(find "$MY_CLAUDE_ROOT/.trash" -path '*-del/project.json' 2>/dev/null)" ] || fail "the project's record should stay for undelete"
[ -n "$(find "$MY_CLAUDE_ROOT/.trash" -path '*-del/origin' 2>/dev/null)" ] && fail "a clone went to the trash instead of off the disk"
# undelete clones each repo again on the branch it was on; one the remote lacks: its default, said so
mc undelete del >/dev/null || fail "undelete del"
git -C "$clone" checkout -q topic
mc delete del >/dev/null || fail "delete a clean clone on a pushed branch"
mc undelete del >/dev/null || fail "undelete del on topic"
[ "$(git -C "$clone" branch --show-current)" = topic ] || fail "undelete should clone the branch it was on, not $(git -C "$clone" branch --show-current)"
git -C "$clone" checkout -q -b never-pushed
mc delete del >/dev/null || fail "delete a clone on an empty local branch"
out=$(mc undelete del 2>&1) || fail "undelete with a branch the remote lacks: $out"
[ "$(git -C "$clone" branch --show-current)" = main ] || fail "a branch the remote lacks: the default branch"
echo "$out" | grep -q "never-pushed" || fail "should say the branch was not there: $out"
# a clone is made beside its folder and moved in whole: a start meanwhile never finds half a checkout
mc delete del >/dev/null || fail "delete del again"
mkdir -p "$tmp/gitwrap"
printf '#!/bin/sh\nfor a; do last=$a; done\n[ "$1" = clone ] && echo "$last" >> %s\nexec %s "$@"\n' "$tmp/clone-dests" "$(command -v git)" > "$tmp/gitwrap/git"
chmod +x "$tmp/gitwrap/git"
PATH="$tmp/gitwrap:$PATH" mc undelete del >/dev/null || fail "undelete del through the git wrapper"
[ "$(cat "$tmp/clone-dests")" = "$clone.cloning" ] || fail "the clone should be made at $clone.cloning, not $(cat "$tmp/clone-dests")"
[ -d "$clone/.git" ] && [ ! -e "$clone.cloning" ] || fail "the clone should be moved into $clone when done"
# and a repo still being cloned is not started
mc delete del >/dev/null; mc undelete del >/dev/null
mv "$clone" "$clone.cloning"
out=$(mc up del --no-attach 2>&1) && fail "started a repo still being cloned: $out"
echo "$out" | grep -q "origin: still being cloned" || fail "should say the repo is still being cloned: $out"
mv "$clone.cloning" "$clone"
# forwarded ports travel with the repo they follow and reach the profile at launch
mkdir -p "$tmp/srv" "$tmp/srv2"; mc new ports >/dev/null
mc add ports "$tmp/srv" --port 20808 --port 8080:80 >/dev/null || fail "add with --port"
[ "$(mc status ports --json | jq -c '.peers[]|select(.repo=="srv").ports')" = '["20808","8080:80"]' ] || fail "the ports should be kept on the repo"
out=$(mc add ports "$tmp/srv2" --port http 2>&1) && fail "a bad port was taken: $out"
echo "$out" | grep -q "http" || fail "should name the bad port: $out"
[ "$(bun -e 'const c = await import(process.argv[1]); console.log(c.launchCtx("ports", "srv").ports.join(" "))' "$MY_CLAUDE_ROOT/src/core.ts")" = "20808 8080:80" ] || fail "the profile should get the ports"
mc delete ports >/dev/null
echo "smoke OK"
