// Does a peer's Claude need the user? Claude Code hooks (injected per launch with
// --settings) write a one-word file per peer under projects/<name>/.attn/: "ask" on a
// permission prompt or a question dialog, "wait" when a turn ends and it sits idle for
// the next prompt; typing a prompt or a tool running clears it. Plain shell, so it
// works inside a container without bun, over the bind-mounted project tree.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS } from "./store.ts";
import { shq } from "./sh.ts";

export type Attention = "ask" | "wait" | null;

const dir = (name: string) => join(PROJECTS, name, ".attn");
const file = (name: string, repo: string) => join(dir(name), repo);

export function attention(name: string, repo: string): Attention {
  try {
    const v = readFileSync(file(name, repo), "utf8").trim();
    return v === "ask" || v === "wait" ? v : null;
  } catch {
    return null;
  }
}

export function clearAttention(name: string, repo: string): void {
  rmSync(file(name, repo), { force: true });
}

// The loudest need across the project's peers.
export function projectAttention(name: string, repos: string[]): Attention {
  if (!existsSync(dir(name))) return null;
  const all = repos.map((r) => attention(name, r));
  return all.includes("ask") ? "ask" : all.includes("wait") ? "wait" : null;
}

// What --settings gets: hooks that keep the file current for this peer.
export function attentionSettings(name: string, repo: string): string {
  const f = shq(file(name, repo));
  const set = (v: string) => ({ type: "command", command: `mkdir -p ${shq(dir(name))} && printf ${v} > ${f}` });
  const clear = { type: "command", command: `rm -f ${f}` };
  return JSON.stringify({
    hooks: {
      Notification: [{ matcher: "permission_prompt|elicitation_dialog", hooks: [set("ask")] }],
      Stop: [{ hooks: [set("wait")] }],
      UserPromptSubmit: [{ hooks: [clear] }],
      PostToolUse: [{ hooks: [clear] }],
    },
  });
}

export const attentionMark = (a: Attention) => (a === "ask" ? "!" : a === "wait" ? "✉" : " ");
export const attentionColor = (a: Attention) => (a === "ask" ? "red" : a === "wait" ? "yellow" : undefined);
