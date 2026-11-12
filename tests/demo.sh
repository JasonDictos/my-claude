#!/usr/bin/env bash
# Record the README demos (docs/demo/*.gif) in a sandbox: temp HOME, host profile,
# a fake claude, generic project names, a private tmux server. Needs asciinema + agg.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/.." && pwd)
out=$repo/docs/demo; mkdir -p "$out"
tmp=$(mktemp -d); trap 'tmux kill-server 2>/dev/null || true; rm -rf "$tmp"' EXIT
export TMUX_TMPDIR=$tmp; unset TMUX
export MY_CLAUDE_ROOT=$tmp/root MY_CLAUDE_CONFIG_DIR=$tmp/cfg MY_CLAUDE_CLAUDE=$here/fake-claude FAKE_CLAUDE_LOG=$tmp/claude.log FAKE_CLAUDE_SAY=$here/say HOME=$tmp/home
mkdir -p "$MY_CLAUDE_ROOT" "$MY_CLAUDE_CONFIG_DIR" "$HOME" "$HOME/src"
ln -s "$repo/src" "$MY_CLAUDE_ROOT/src"; ln -s "$repo/bin" "$MY_CLAUDE_ROOT/bin"; ln -s "$repo/node_modules" "$MY_CLAUDE_ROOT/node_modules"
echo '{"profile":"host","peers":{"cli":"/nonexistent"}}' > "$MY_CLAUDE_CONFIG_DIR/config.json"
for r in api web worker docs; do
  mkdir -p "$HOME/src/$r"; git -C "$HOME/src/$r" init -q -b main
  for m in "scaffold" "wire the v2 client" "review fixes"; do git -C "$HOME/src/$r" -c user.name=demo -c user.email=demo@example.com commit -q --allow-empty -m "$m"; done
done
mc() { bun "$MY_CLAUDE_ROOT/src/cli.ts" "$@"; }

# Fixture projects.
mc new api-overhaul --color blue >/dev/null;  mc add api-overhaul ~/src/api ~/src/web ~/src/worker >/dev/null
mc lead api-overhaul api "Move web and worker onto the v2 API; keep the old endpoints until the worker is cut over." >/dev/null
mc new docs-refresh --color green >/dev/null; mc add docs-refresh ~/src/docs >/dev/null
mc up api-overhaul --no-attach >/dev/null; sleep 1

keys() { local t=$1; shift; for k in "$@"; do tmux send-keys -t "$t" "$k"; sleep "${DELAY:-0.6}"; done; }
type_slow() { local t=$1 s=$2; local i; for ((i=0;i<${#s};i++)); do tmux send-keys -t "$t" -l "${s:i:1}"; sleep 0.08; done; }

record() { # name cols rows cmd -> starts asciinema in a tmux pane named rec
  local name=$1 cols=$2 rows=$3 cmd=$4
  tmux kill-session -t rec 2>/dev/null || true
  tmux new-session -d -s rec -x "$cols" -y "$rows" \
    "asciinema rec -q --overwrite --cols $cols --rows $rows -c '$cmd' '$tmp/$name.cast'"
  sleep 2
}
finish() { # name: wait for the recording to end, render the gif
  local name=$1
  for _ in $(seq 60); do tmux has-session -t rec 2>/dev/null || break; sleep 0.5; done
  cp "$tmp/$name.cast" "$out/$name.cast"
  agg --theme monokai --font-size 16 --speed 1.2 "$tmp/$name.cast" "$out/$name.gif" 2>/dev/null
  echo "wrote $out/$name.gif"
}

if [[ "${1:-}" != "shot" ]]; then
# Demo 1: the menu. Projects -> open -> add with prediction -> color -> back -> quit.
record menu 110 26 "env MY_CLAUDE_ROOT=$MY_CLAUDE_ROOT MY_CLAUDE_CONFIG_DIR=$MY_CLAUDE_CONFIG_DIR bun $MY_CLAUDE_ROOT/src/cli.ts"
sleep 2
keys rec Down Up Enter
sleep 1.2
keys rec a; type_slow rec "~/src/wo"; sleep 1; keys rec Tab; sleep 1; keys rec Enter
sleep 1.5
keys rec c Right Right Enter
sleep 1.2
keys rec Escape; sleep 1; keys rec Down Enter; sleep 1.2; keys rec Escape; sleep 0.8; keys rec q
finish menu

# Demo 2: the CLI.
cat > "$tmp/cli-demo.sh" <<EOF
set -e
PS1='\$ '
run() { printf '\033[1;32m\$\033[0m %s\n' "\$*"; sleep 0.8; "\$@"; echo; sleep 1.2; }
run my-claude ls
run my-claude status api-overhaul
run my-claude new payments-cutover --color orange
run my-claude add payments-cutover ~/src/api ~/src/worker
run my-claude up payments-cutover --no-attach
sleep 1
run my-claude status payments-cutover
run my-claude down payments-cutover
run my-claude ls
sleep 2
EOF
mkdir -p "$tmp/bin"; ln -s "$MY_CLAUDE_ROOT/src/cli.ts" "$tmp/bin/my-claude"
record cli 110 30 "env PATH=$tmp/bin:$PATH MY_CLAUDE_ROOT=$MY_CLAUDE_ROOT MY_CLAUDE_CONFIG_DIR=$MY_CLAUDE_CONFIG_DIR bash $tmp/cli-demo.sh"
finish cli

# Demo 3: the tmux session a project becomes (status bar, tiled panes).
record tmux 110 26 "env -u TMUX MY_CLAUDE_ROOT=$MY_CLAUDE_ROOT MY_CLAUDE_CONFIG_DIR=$MY_CLAUDE_CONFIG_DIR bun $MY_CLAUDE_ROOT/src/cli.ts attach api-overhaul"
sleep 3
tmux send-keys -t rec C-b d
finish tmux
fi

# The screenshot: always, after the gifs (or alone with: tests/demo.sh shot).
# Screenshot: a project session as it looks in use (docs/screenshot.png): side panel,
# one Claude per repo, a prefix+h shell on the first peer, the status bar.
mc new search-rewrite --color purple >/dev/null; mc add search-rewrite ~/src/api >/dev/null
record shot 200 50 "env -u TMUX MY_CLAUDE_ROOT=$MY_CLAUDE_ROOT MY_CLAUDE_CONFIG_DIR=$MY_CLAUDE_CONFIG_DIR bun $MY_CLAUDE_ROOT/src/cli.ts attach api-overhaul"
sleep 3
# the prefix+h shell pane on api: a host shell here, titled like the real one
tmux send-keys -t rec C-b h; sleep 2
tmux send-keys -t rec -l 'git --no-pager log --oneline -3'; tmux send-keys -t rec Enter; sleep 1.5
tmux send-keys -t rec C-b d
for _ in $(seq 60); do tmux has-session -t rec 2>/dev/null || break; sleep 0.5; done
agg --theme monokai --font-size 14 --last-frame-duration 1 "$tmp/shot.cast" "$tmp/shot.gif" 2>/dev/null
# The frame just before the detach is the complete session.
magick "$tmp/shot.gif" -coalesce "$tmp/frame-%03d.png"
cp "$(ls "$tmp"/frame-*.png | tail -2 | head -1)" "$repo/docs/screenshot.png"
echo "wrote $repo/docs/screenshot.png"
