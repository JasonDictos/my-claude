// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// host profile: no container, `claude` straight on this machine. Also the
// template for a new world. MY_CLAUDE_CLAUDE overrides the binary for tests.
import { loginShell, run } from "../sh.ts";
import { config } from "../store.ts";
import type { LaunchCtx, Profile } from "./types.ts";

function claude(ctx: LaunchCtx): number {
  const env = { ...process.env, MY_CLAUDE_PROJECT: ctx.project, MY_CLAUDE_PEER: ctx.repo };
  if (process.env.MY_CLAUDE_CLAUDE) return run(process.env.MY_CLAUDE_CLAUDE, ctx.args, { cwd: ctx.path, env });
  // claude first, then the shell stays up (a double Ctrl-C lands at a prompt); a login shell,
  // so a claude wrapper from the user's profile applies
  const login = config().shell?.login !== false;
  return run("bash", login ? ["-lic", `${ctx.cmdline}; exec bash -li`] : ["-ic", `. /etc/profile.d/claude.sh; ${ctx.cmdline}; exec bash -i`], { cwd: ctx.path, env });
}

export const host: Profile = {
  shellInto: (_c, path) => { const sh = loginShell(config().shell?.login !== false); return run(sh.shell, sh.args, { cwd: path }); },
  launch: claude,
  exec: claude,
  containerReady: () => true,
  paneEnv: () => ({}),
};
