// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Consoles: plain shells on this machine, not tied to a project. One tmux session holds them,
// a window each, named console1, console2… (unique: a name is how the user tells them apart).
import { homedir } from "node:os";
import { loginShell, sh, shOk } from "./sh.ts";
import { config } from "./store.ts";
import { SEP, VIEW_PREFIX, ensureServer, historyLimit, nativePanes } from "./tmux.ts";

// Not "mc-…": that is a project's session, and the terminal UI cycles through those.
export const SESSION = "my-claude-consoles";
export const TAB = "_consoles"; // what the window calls their group (no project name starts with "_")
export const NODE = `c:${TAB}`;
// each console's own entry under it, and back
export const nodeOf = (pane: string) => `${NODE}/${pane}`;
export const paneOf = (node: string) => node.startsWith(`${NODE}/`) ? node.slice(NODE.length + 1) : "";
export const NAME_MAX = 32; // the rename boxes stop there
const NAME_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${NAME_MAX - 1}}$`);

export interface Console { name: string; pane: string; window: string; index: number; command: string; shell: boolean }

export async function list(): Promise<Console[]> {
  const out = await sh("tmux", ["list-panes", "-s", "-t", `=${SESSION}`, "-F", ["#{window_name}", "#{pane_id}", "#{window_id}", "#{window_index}", "#{pane_current_command}", "#{pane_dead}"].join(SEP)], { ok: true });
  const shell = (process.env.SHELL || "bash").split("/").pop();
  return out.split("\n").filter(Boolean).map((l) => l.split(SEP)).filter((f) => f[5] !== "1")
    .map(([name, pane, window, index, command]) => ({ name, pane, window, index: Number(index), command, shell: command === shell || /^-?(ba|z|fi|k|tc|c|da)?sh$/.test(command) }))
    .sort((a, b) => a.index - b.index);
}

// The first free "consoleN".
export const nextName = (have: string[]): string => { let n = 1; while (have.includes(`console${n}`)) n++; return `console${n}`; };

// A new console in the home folder; its pane id.
export async function open(): Promise<string> {
  const have = await list();
  const name = nextName(have.map((c) => c.name));
  const { shell, args } = loginShell(config().shell?.login !== false);
  const where = ["-n", name, "-c", homedir(), "-P", "-F", "#{pane_id}"];
  let pane: string;
  if (!await shOk("tmux", ["has-session", "-t", `=${SESSION}`])) {
    await ensureServer();
    // the first pane takes the global history limit as it is made: ours is lent for that
    const limit = historyLimit();
    const create = ["new-session", "-d", "-s", SESSION, "-x", "160", "-y", "48", ...where, shell, ...args];
    const before = limit ? await sh("tmux", ["start-server", ";", "show-options", "-gv", "history-limit"], { ok: true }) : "";
    try {
      pane = (await sh("tmux", limit ? ["set-option", "-g", "history-limit", String(limit), ";", ...create] : create)).trim();
    } finally {
      if (before) await sh("tmux", ["set-option", "-g", "history-limit", before], { ok: true });
    }
    if (limit) await sh("tmux", ["set-option", "-t", `=${SESSION}`, "history-limit", String(limit)], { ok: true });
  } else {
    pane = (await sh("tmux", ["new-window", "-d", "-t", `=${SESSION}:`, ...where, shell, ...args])).trim();
  }
  await dress(pane);
  return pane;
}

// The window names it; nothing the shell prints renames it. Natively the app sizes it.
async function dress(pane: string): Promise<void> {
  const set = (k: string, v: string) => ["set-option", "-w", "-t", pane, k, v];
  const opts: [string, string][] = [["automatic-rename", "off"], ["allow-rename", "off"], ["allow-set-title", "off"], ["aggressive-resize", "off"], ["window-size", nativePanes() ? "manual" : "smallest"]];
  await sh("tmux", opts.flatMap(([k, v], i) => [...(i ? [";"] : []), ...set(k, v)]), { ok: true });
}

// A new name for a console: one no other console has.
export async function rename(pane: string, raw: string): Promise<string> {
  const name = raw.trim();
  if (!NAME_RE.test(name)) throw new Error(`'${name}' is no console name: letters, digits, . _ - (up to 32)`);
  const all = await list();
  const me = all.find((c) => c.pane === pane);
  if (!me) throw new Error("that console is gone");
  if (all.some((c) => c.pane !== pane && c.name === name)) throw new Error(`there is already a console called ${name}`);
  await sh("tmux", ["rename-window", "-t", me.window, name]);
  return name;
}

export async function close(pane: string): Promise<void> {
  await sh("tmux", ["kill-pane", "-t", pane], { ok: true });
}

// view mode (the fallback): a session of its own showing one console, gone with its client
export async function viewArgs(c: Console, sock: string): Promise<string[]> {
  const v = `${VIEW_PREFIX}${TAB}-${c.pane.replace(/^%/, "")}`;
  await sh("tmux", ["kill-session", "-t", `=${v}`], { ok: true });
  const set = (k: string, val: string) => ["set-option", k, val, ";"];
  return ["new-session", "-t", SESSION, "-s", v, ";", ...set("status", "off"), ...set("destroy-unattached", "on"), ...(sock ? set("@mc_host_sock", sock) : []),
    "select-window", "-t", `:${c.index}`, ";", "set-hook", "session-window-changed", "kill-session"];
}
