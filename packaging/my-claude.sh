#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# /usr/bin/my-claude from the RPM: the compiled program, run on a data root of the user's own
# (~/.local/share/my-claude), which also gets a copy of it for containers that see only $HOME.
lib=@LIBDIR@/my-claude
root="${MY_CLAUDE_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/my-claude}"
export MY_CLAUDE_ROOT="$root"
stamp="$root/dist/.package-version"
# refreshed for a new version, and for a new build of the same one (my-claude deploy)
if [ "$(cat "$stamp" 2>/dev/null)" != "@VERSION@" ] || [ ! -x "$root/dist/my-claude" ] || [ ! -x "$root/bin/my-claude" ] || [ "$lib/my-claude" -nt "$root/dist/my-claude" ]; then
  mkdir -p "$root/bin" "$root/dist" "$root/host"
  cp -f "$lib/my-claude" "$root/dist/.my-claude.new" && mv -f "$root/dist/.my-claude.new" "$root/dist/my-claude"
  cat > "$root/bin/my-claude.new" <<'SH'
#!/bin/sh
# Written by /usr/bin/my-claude: what tmux hooks, peers and containers run.
root=$(cd "$(dirname "$0")/.." && pwd)
export MY_CLAUDE_ROOT="${MY_CLAUDE_ROOT:-$root}"
exec "$root/dist/my-claude" "$@"
SH
  chmod 755 "$root/bin/my-claude.new" && mv -f "$root/bin/my-claude.new" "$root/bin/my-claude"
  ln -sfn @DATADIR@/my-claude/icons "$root/host/icons"
  echo "@VERSION@" > "$stamp"
fi
exec "$root/dist/my-claude" "$@"
