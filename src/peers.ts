// claude-peers: the group named after the project, and the briefs sent to its members.
// Goes through the broker's own CLI (config.json peers.cli, default ~/claude-peers-mcp/cli.ts).
import { existsSync } from "node:fs";
import { config } from "./store.ts";

const HOME = process.env.HOME ?? "";
const cli = () => ((config().peers?.cli as string | undefined) ?? "~/claude-peers-mcp/cli.ts").replace(/^~/, HOME);

export function available(): boolean {
  return existsSync(cli());
}

async function run(args: string[]): Promise<{ ok: boolean; out: string }> {
  if (!available()) return { ok: false, out: `claude-peers CLI not found at ${cli()}` };
  const proc = Bun.spawn([process.execPath, cli(), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, out: (stdout + stderr).trim() };
}

// Replace the group's membership with these targets (paths resolve to whatever session sits there).
export const setGroup = (name: string, members: string[]) => run(["group", name, ...members]);
export const deleteGroup = (name: string) => run(["group", "rm", name]);
export const send = (target: string, text: string) => run(["send", target, text]);
