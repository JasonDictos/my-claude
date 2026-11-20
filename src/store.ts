// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Project records: projects/<name>/project.json is the single source of truth.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Role = "lead" | "peer";
export type Mode = "per-repo" | "shared";
// grid: peers tiled in shared tmux windows with the side panel (the terminal UI).
// solo: every pane in a window of its own, which is what the native app shows one by one.
export type Layout = "grid" | "solo";

export interface Peer {
  repo: string;
  path: string;
  role: Role;
  model: string | null;
  session: string;
  origin?: string; // "org/repo" when my-claude cloned it: enough to clone it again after undelete
  branch?: string;
  kickoff?: string; // first prompt, sent once when the conversation is new (a work order)
}

export interface Project {
  name: string;
  goal: string;
  mode: Mode;
  profile: string;
  lead: string | null;
  color?: string | null;
  by?: string; // "<project>/<repo>" of the session that started this one, if a Claude did
  ticket?: string | null; // tracker issue the project is for (e.g. a Jira key); context for every peer
  peers: Peer[];
  removed?: (Peer & { when: number })[]; // peers taken out, newest last: enough to put one back with its conversation
  layout?: Layout; // absent = grid
  running?: boolean; // brought up and not brought down: what auto-restart brings back
}

export const ROOT = process.env.MY_CLAUDE_ROOT ?? resolve(import.meta.dir, "..");
export const PROJECTS = join(ROOT, "projects");
// User configuration and external profiles live outside the checkout.
export const CONFIG_DIR = process.env.MY_CLAUDE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "my-claude");
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class UsageError extends Error {}

// "Bash Completion" -> "bash-completion": what the menu does with a typed name.
export function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
}

export function die(msg: string): never {
  throw new UsageError(msg);
}

// Settings: ~/.config/my-claude/settings.json (the user's), and /etc/my-claude/settings.json,
// whose "daemon" section wins over the user's. The old name, config.json, is moved once.
export const SYSTEM_SETTINGS = process.env.MY_CLAUDE_SYSTEM_SETTINGS ?? "/etc/my-claude/settings.json";
const userSettings = () => join(CONFIG_DIR, "settings.json");
const readJson = (f: string): Record<string, any> | null => {
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
};
export function config(): Record<string, any> {
  const f = userSettings(), old = join(CONFIG_DIR, "config.json");
  if (!existsSync(f) && existsSync(old)) {
    try { renameSync(old, f); } catch { return readJson(old) ?? {}; }
  }
  return readJson(f) ?? readJson(join(ROOT, "settings.json")) ?? readJson(join(ROOT, "config.json")) ?? {};
}
// The daemon's settings: /etc over the user's, falling back to the old top-level keys.
export function daemonSettings(): Record<string, any> {
  const u = config();
  const legacy: Record<string, any> = {};
  if (u.autoRestart !== undefined) legacy.autoRestart = u.autoRestart;
  if (u.ssh !== undefined) legacy.ssh = u.ssh;
  return mergeSettings(mergeSettings(legacy, u.daemon ?? {}), readJson(SYSTEM_SETTINGS)?.daemon ?? {});
}

function mergeSettings(a: any, b: any): any {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return b;
  const o: Record<string, any> = a && typeof a === "object" && !Array.isArray(a) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) {
    if (v === null) delete o[k];
    else o[k] = mergeSettings(o[k], v);
  }
  return o;
}

// Merge a patch into the user's settings.json (created on demand): objects merge key by
// key, null removes a key, anything else replaces. Returns the new settings.
export function saveConfig(patch: Record<string, any>): Record<string, any> {
  const next = mergeSettings(config(), patch);
  const f = userSettings();
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(next, null, 2) + "\n");
  renameSync(f + ".tmp", f);
  return next;
}

export function defaultProfile(): string {
  return config().profile ?? "host";
}

const file = (name: string) => join(PROJECTS, name, "project.json");

export function listProjects(): Project[] {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS)
    .filter((n) => existsSync(file(n)))
    .sort()
    .map((n) => load(n));
}

export function exists(name: string): boolean {
  return existsSync(file(name));
}

export function load(name: string): Project {
  if (!NAME_RE.test(name)) die(`bad project name '${name}'`);
  if (!existsSync(file(name))) die(`no project '${name}' (my-claude ls)`);
  const p = JSON.parse(readFileSync(file(name), "utf8")) as Project;
  for (const x of p.peers) if ((x.role as string) === "support") x.role = "peer"; // pre-2026-11-09 records
  return p;
}

export function save(p: Project): void {
  const f = file(p.name);
  mkdirSync(join(PROJECTS, p.name), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(p, null, 2) + "\n");
  renameSync(f + ".tmp", f);
}

// A deleted project goes to .trash/<stamp>-<name>, never straight to rm -rf:
// a fresh clone in it may hold work nothing else has.
export function remove(name: string): string {
  const trash = join(ROOT, ".trash");
  mkdirSync(trash, { recursive: true });
  const dest = join(trash, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
  renameSync(join(PROJECTS, name), dest);
  return dest;
}

export interface Trashed { dir: string; name: string; when: number; peers: string[] }

// What .trash/ holds, newest first. The project.json inside is what matters: peer
// paths and session ids are how Claude's conversations are keyed.
export function trashed(): Trashed[] {
  const trash = join(ROOT, ".trash");
  if (!existsSync(trash)) return [];
  return readdirSync(trash)
    .filter((d) => existsSync(join(trash, d, "project.json")))
    .map((d) => {
      const p = JSON.parse(readFileSync(join(trash, d, "project.json"), "utf8")) as Project;
      const m = d.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/);
      const when = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : 0;
      return { dir: d, name: p.name, when, peers: p.peers.map((x) => x.repo) };
    })
    .sort((a, b) => b.when - a.when);
}

// Move a trashed project back under projects/: same name, same paths. `which` is a
// project name (its newest trash entry) or a .trash/ directory name.
export function restore(which: string): Project {
  const all = trashed();
  const t = all.find((x) => x.dir === which) ?? all.find((x) => x.name === which);
  if (!t) die(`nothing named '${which}' in .trash (my-claude undelete lists it)`);
  if (exists(t.name)) die(`a project '${t.name}' already exists; delete or rename it first`);
  mkdirSync(PROJECTS, { recursive: true });
  renameSync(join(ROOT, ".trash", t.dir), join(PROJECTS, t.name));
  return load(t.name);
}

export function peerOf(p: Project, repo: string): Peer {
  const peer = p.peers.find((x) => x.repo === repo);
  if (!peer) die(`no peer '${repo}' in ${p.name}`);
  return peer;
}

// Pre-answer Claude Code's "trust this folder?" for a peer's directory: a fresh
// clone the user asked for should open straight into the session.
export function trustPath(path: string): void {
  const f = join(process.env.HOME ?? "", ".claude.json");
  let cfg: any = {};
  try {
    cfg = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return; // no Claude config yet; the dialog will ask once
  }
  cfg.projects ??= {};
  if (cfg.projects[path]?.hasTrustDialogAccepted) return;
  cfg.projects[path] = { ...(cfg.projects[path] ?? {}), hasTrustDialogAccepted: true };
  writeFileSync(f + ".my-claude.tmp", JSON.stringify(cfg, null, 2));
  renameSync(f + ".my-claude.tmp", f);
}

// Claude Code keeps transcripts under ~/.claude/projects/<cwd with non-alnum -> ->/<id>.jsonl
export function transcriptDir(cwd: string): string {
  return join(process.env.HOME ?? "", ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}
export function transcriptPath(cwd: string, session: string): string {
  return join(transcriptDir(cwd), `${session}.jsonl`);
}

// The repo's most recent non-empty conversation, so an existing checkout keeps its history.
export function latestSession(cwd: string): string | null {
  const dir = transcriptDir(cwd);
  if (!existsSync(dir)) return null;
  let best: { id: string; m: number } | null = null;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^([0-9a-f-]{36})\.jsonl$/);
    if (!m) continue;
    const st = statSync(join(dir, f));
    if (st.size > 0 && (!best || st.mtimeMs > best.m)) best = { id: m[1], m: st.mtimeMs };
  }
  return best?.id ?? null;
}
