// host profile: no container, `claude` straight on this machine. Also the
// template for a new world. MY_CLAUDE_CLAUDE overrides the binary for tests.
import { run } from "../sh.ts";
import type { LaunchCtx, Profile } from "./types.ts";

function claude(ctx: LaunchCtx): number {
  const env = { ...process.env, MY_CLAUDE_PROJECT: ctx.project, MY_CLAUDE_PEER: ctx.repo };
  if (process.env.MY_CLAUDE_CLAUDE) return run(process.env.MY_CLAUDE_CLAUDE, ctx.args, { cwd: ctx.path, env });
  // An interactive shell that runs claude first and stays up when it exits (a double
  // Ctrl-C lands at a prompt, not a dead pane). claude() comes from /etc/profile.d/claude.sh.
  return run("bash", ["-ic", `. /etc/profile.d/claude.sh; ${ctx.cmdline}; exec bash -i`], { cwd: ctx.path, env });
}

export const host: Profile = {
  shellInto: (_c, path) => run(process.env.SHELL ?? "bash", [], { cwd: path }),
  launch: claude,
  exec: claude,
  containerReady: () => true,
  paneEnv: () => ({}),
};
