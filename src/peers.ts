// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// claude-peers: the group named after the project, and the briefs sent to its members.
// Goes through the broker's own CLI (settings.json peers.cli, default ~/claude-peers-mcp/cli.ts).
import { existsSync } from "node:fs";
import { config } from "./store.ts";

const HOME = process.env.HOME ?? "";
const cli = () => ((config().peers?.cli as string | undefined) ?? "~/claude-peers-mcp/cli.ts").replace(/^~/, HOME);

export function available(): boolean {
  return existsSync(cli());
}

// The CLI is a bun script. Compiled (a peer's MCP server in a container), our own binary is
// bun only when told so; it would take the script for a my-claude command.
const PLAIN = { ...process.env, BUN_BE_BUN: "1" };
// my-claude's own notes are signed by it, not by whichever Claude session it runs under (or
// beside, in the same folder): replies would go there. A CLI without this ignores it.
const SIGNED = { ...PLAIN, CLAUDE_PEERS_FROM: "my-claude-app" };

async function run(args: string[], env: Record<string, string | undefined> = PLAIN): Promise<{ ok: boolean; out: string }> {
  if (!available()) return { ok: false, out: `claude-peers CLI not found at ${cli()}` };
  const proc = Bun.spawn([process.execPath, cli(), ...args], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, out: (stdout + stderr).trim() };
}

// Replace the group's membership with these targets (paths resolve to whatever session sits there).
export const setGroup = (name: string, members: string[]) => run(["group", name, ...members]);
export const deleteGroup = (name: string) => run(["group", "rm", name]);
export const send = (target: string, text: string) => run(["send", target, text], SIGNED);
export const broadcast = (group: string, text: string) => run(["broadcast", group, text], SIGNED);

// Same, blocking: for callers that are about to block the event loop themselves.
export function broadcastSync(group: string, text: string): void {
  if (available()) Bun.spawnSync([process.execPath, cli(), "broadcast", group, text], { env: SIGNED });
}

// The user as a peer: typed lines go to the group, replies print in each peer's colour.
export function chat(group: string, who: string, cwd: string, colors: Record<string, string> = {}): number {
  if (!available()) { console.error(`claude-peers CLI not found at ${cli()}`); return 1; }
  return Bun.spawnSync([process.execPath, cli(), "chat", group, "--name", who, "--cwd", cwd], {
    stdio: ["inherit", "inherit", "inherit"], env: { ...PLAIN, CLAUDE_PEERS_CHAT_COLORS: JSON.stringify(colors) },
  }).exitCode ?? 1;
}
