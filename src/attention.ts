// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// What a peer is up to, for the user: hooks injected per launch write "work", "ask" or "wait" to
// a file per peer under projects/<name>/.attn/; plain shell, so they work in a container without bun.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS } from "./store.ts";
import { shq } from "./sh.ts";

export type Attention = "work" | "ask" | "wait" | null;

const dir = (name: string) => join(PROJECTS, name, ".attn");
const file = (name: string, repo: string) => join(dir(name), repo);

export function attention(name: string, repo: string): Attention {
  try {
    const v = readFileSync(file(name, repo), "utf8").trim();
    return v === "work" || v === "ask" || v === "wait" ? v : null;
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
  // Stop never comes for an interrupted turn, nor for a session that died: "work" ends there too
  const idle = { type: "command", command: `[ "$(cat ${f} 2>/dev/null)" = work ] && rm -f ${f}; true` };
  return JSON.stringify({
    hooks: {
      Notification: [{ matcher: "permission_prompt|elicitation_dialog", hooks: [set("ask")] }, { matcher: "idle_prompt", hooks: [idle] }],
      Stop: [{ hooks: [set("wait")] }],
      UserPromptSubmit: [{ hooks: [set("work")] }],
      PostToolUse: [{ hooks: [set("work")] }],
      // not on "compact": that one comes mid-turn
      SessionStart: [{ matcher: "startup|resume", hooks: [idle] }],
    },
  });
}

export const attentionMark = (a: Attention) => (a === "ask" ? "!" : a === "wait" ? "✉" : " ");
export const attentionColor = (a: Attention) => (a === "ask" ? "red" : a === "wait" ? "yellow" : undefined);
