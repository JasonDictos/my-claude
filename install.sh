#!/usr/bin/env bash
# my-claude installer:  curl -fsSL https://raw.githubusercontent.com/JasonDictos/my-claude/main/install.sh | bash
# Clones (or updates) the checkout, installs bun if missing, puts `my-claude` on PATH,
# and seeds ~/.config/my-claude/config.json. Re-running is safe.
set -euo pipefail

REPO=${MY_CLAUDE_REPO:-https://github.com/JasonDictos/my-claude.git}
HOME_DIR=${MY_CLAUDE_HOME:-$HOME/my-claude}
BIN_DIR=${MY_CLAUDE_BIN:-$HOME/.local/bin}
CONFIG_DIR=${MY_CLAUDE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/my-claude}

say() { printf '\033[1;36mmy-claude\033[0m %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "my-claude: needs $1 on PATH" >&2; exit 1; }; }

need git; need tmux
command -v claude >/dev/null 2>&1 || say "warning: 'claude' (Claude Code) not on PATH; peers won't start until it is"

BUN_HOME=${BUN_INSTALL:-$HOME/.bun}
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$BUN_HOME/bin/bun" ]; then
  say "installing bun into $BUN_HOME..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
fi
BUN=$(command -v bun 2>/dev/null || echo "$BUN_HOME/bin/bun")
[ -x "$BUN" ] || { echo "my-claude: bun not found after install (looked at $BUN)" >&2; exit 1; }

if [ -d "$HOME_DIR/.git" ]; then
  say "updating $HOME_DIR"
  git -C "$HOME_DIR" pull --ff-only -q
else
  say "cloning into $HOME_DIR"
  git clone -q "$REPO" "$HOME_DIR"
fi

say "installing dependencies"
(cd "$HOME_DIR" && "$BUN" install --silent)

mkdir -p "$BIN_DIR" "$CONFIG_DIR/profiles"
ln -sfn "$HOME_DIR/src/cli.ts" "$BIN_DIR/my-claude"
[ -f "$CONFIG_DIR/config.json" ] || cp "$HOME_DIR/config.example.json" "$CONFIG_DIR/config.json"

case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "note: add $BIN_DIR to your PATH" ;; esac
say "installed. Run: my-claude      (config: $CONFIG_DIR/config.json, profiles: $CONFIG_DIR/profiles/)"
