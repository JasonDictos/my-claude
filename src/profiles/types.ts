// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// A profile is the world-specific part: how a peer's claude starts (bare, in a container…) and
// the actions that only make sense there.

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
  createProject?: { name: string; goal: string; shared?: boolean; ticket?: string };
}

// What a profile sees when the core builds a peer's system-prompt brief.
export interface BriefCtx {
  project: string;
  repo: string;
  path: string;
  goal: string;
  ticket: string | null;
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
  // Extra lines for the peer's brief (indexes, the sprint, the ticket's text); synchronous and
  // run at every launch, so keep it fast.
  brief?(ctx: BriefCtx): string[];
  // A JSON Schema (scalar properties) for the profile's section of settings.json, shown as a
  // form in the window's Settings.
  schema?: Record<string, unknown>;
}
