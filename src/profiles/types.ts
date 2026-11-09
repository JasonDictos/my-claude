// A profile is the world-specific part: how a peer's claude is actually started
// (bare, in a container, over ssh...), plus any menu actions that only make
// sense in that world. The core only ever calls these.

// Handed to an external profile's factory so it can reuse the core's helpers.
export interface ProfileApi {
  run(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }): number;
  out(cmd: string, args: string[], opts?: { cwd?: string; ok?: boolean }): string;
  shq(s: string): string;
  config(): Record<string, any>;
  home: string;
}
export interface LaunchCtx {
  project: string;
  repo: string;
  path: string;
  session: string;
  mode: "per-repo" | "shared";
  container: string; // mc-<project>; only meaningful in shared mode
  args: string[]; // claude arguments (--resume/--session-id, --model, --name)
  // The same thing as one shell line, MY_CLAUDE_* prefixed: `MY_CLAUDE_PROJECT=x MY_CLAUDE_PEER=y claude --resume ...`.
  // Profiles run it inside an interactive shell that stays up after claude exits.
  cmdline: string;
}

export interface ActionPrompt {
  label: string;
  kind?: "text" | "choice";
  choices?: string[];
  default?: string;
}

export interface ActionResult {
  message: string;
  // Ask the core to create this project (and open it) once the action succeeds.
  createProject?: { name: string; goal: string; shared?: boolean };
}

// A menu hotkey the profile adds to the projects screen (shown in the key bar).
export interface ProfileAction {
  key: string; // single character; uppercase = shift
  label: string;
  prompts: ActionPrompt[];
  run(answers: string[]): Promise<ActionResult>;
}

export interface Profile {
  // An interactive shell in the peer's own container (by id) at its cwd; null = no container found.
  shellInto(container: string | null, path: string): number;
  // Run the peer in the foreground; per-repo, or the shared container's first peer. Returns exit status.
  launch(ctx: LaunchCtx): number;
  // Shared mode, peers 2..n: run claude inside the already running container.
  exec(ctx: LaunchCtx): number;
  // Shared mode: true once exec() will work.
  containerReady(container: string): boolean;
  // Extra environment for the tmux pane (panes start from the tmux server's env).
  paneEnv(project: string, repo: string): Record<string, string>;
  actions?: ProfileAction[];
}
