// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// The commands, shared by the CLI, the menu, the MCP server and the window's driver. Child
// processes are awaited, never blocked on, except where a program IS a pane's foreground job.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { containerOf, killOccupant, lockInfo, occupantPid, occupantsIndex, peerState, peerStateOf, projectState, type PeerState, type ProjectState } from "./live.ts";
import { profile } from "./profiles/index.ts";
import { homedir } from "node:os";
import { pause, sh, shOk, shq, sleep, loginShell } from "./sh.ts";
import * as peers from "./peers.ts";
import {
  CONFIG_DIR, NAME_RE, PROJECTS, ROOT, config, daemonSettings, defaultProfile, die, exists, latestSession, listProjects, load, peerOf, remove, restore, save, slug, transcriptDir, transcriptPath, trustPath,
  type Layout, type Mode, type Peer, type Project, type Role,
} from "./store.ts";
export { trashed } from "./store.ts";
import * as tmux from "./tmux.ts";
import { PALETTE, projectColor } from "./colors.ts";
import { attention, attentionMark, attentionSettings, clearAttention, projectAttention, type Attention } from "./attention.ts";
import { mcpConfig } from "./mcp.ts";

export interface PeerStatus extends Peer {
  state: PeerState;
  pane: string | null;
  pid: number | null;
  lock: Record<string, unknown> | null;
  attn: Attention; // "ask": waiting on a permission/question; "wait": turn done, idle for the next prompt
}
export interface ProjectStatus extends Project {
  state: ProjectState;
  peers: PeerStatus[];
  strays: string[]; // pane titles in the window that belong to no peer
}
export interface ProjectRow {
  name: string;
  peers: number;
  lead: string | null;
  mode: Mode;
  profile: string;
  goal: string;
  color: string | null;
  state: ProjectState;
  attn: Attention;
  last_used: number; // epoch seconds, 0 = never
}

// One stable command for tmux hooks, pane commands and the MCP config: bun on the
// source where bun exists, the compiled binary (dist/) where it does not.
export const CLI = `${ROOT}/bin/my-claude`;

// dist/my-claude is what containers run; keep it no older than the source. Host only.
export async function ensureBinary(): Promise<string | null> {
  if (!existsSync(join(ROOT, "src", "cli.ts")) || !/\/bun$/.test(process.execPath)) return null;
  const bin = join(ROOT, "dist", "my-claude");
  let newest = 0;
  const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const fp = join(d, f.name); if (f.isDirectory()) walk(fp); else newest = Math.max(newest, statSync(fp).mtimeMs); } };
  walk(join(ROOT, "src"));
  const have = statSync(bin, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (have > newest) return null;
  const proc = Bun.spawn([process.execPath, "build", "--compile", join(ROOT, "src", "cli.ts"), "--outfile", bin], { cwd: ROOT, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return code === 0 ? `rebuilt ${bin}` : `dist/my-claude build failed: ${err.trim().split("\n").pop()}`;
}

export function newProject(name: string, o: { goal?: string; shared?: boolean; profile?: string; color?: string; ticket?: string } = {}): Project {
  if (!NAME_RE.test(name)) die(`bad project name '${name}'`);
  if (exists(name)) die(`project '${name}' exists`);
  const prof = o.profile ?? defaultProfile();
  profile(prof);
  if (o.color && !PALETTE[o.color]) die(`no color '${o.color}' (have: ${Object.keys(PALETTE).join(", ")})`);
  const p: Project = { name, goal: o.goal ?? "", mode: o.shared ? "shared" : "per-repo", profile: prof, lead: null, color: o.color ?? null, ticket: o.ticket ? ticketKey(o.ticket) : null, peers: [] };
  save(p);
  return p;
}

// A tracker key as users type it ("abc-123" -> "ABC-123"); "" or "-" clears it.
export function ticketKey(s: string): string | null {
  const t = s.trim().toUpperCase();
  if (!t || t === "-") return null;
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(t)) die(`'${s}' is not a ticket key (like ABC-123)`);
  return t;
}

export function setTicket(name: string, key: string): string | null {
  const p = load(name);
  p.ticket = ticketKey(key);
  save(p);
  void tellGroup(p, p.ticket ? `project "${p.name}" is now for ticket ${p.ticket}.` : `project "${p.name}" no longer has a ticket.`);
  return p.ticket;
}

// --- Symbol index: ctags over each peer's checkout at every launch, in the project dir so a
// container that sees the project sees the index.
export const indexDir = (name: string, repo: string) => join(PROJECTS, name, ".my-claude", repo);
export const indexFile = (name: string, repo: string) => join(indexDir(name, repo), "tags");
const CTAGS_ARGS = [
  "--c++-kinds=+p", "--fields=+iaSn", "--extras=+q", "--tag-relative=no", "--languages=-JSON,-SVG,-XML",
  "--exclude=.git", "--exclude=build*", "--exclude=node_modules", "--exclude=.root", "--exclude=vcpkg",
  "--exclude=*.min.js", "--exclude=dist", "--exclude=.cache",
];

// Starts the indexer; returns at once. `wait` blocks (CLI, tests). Silent without ctags.
export async function index(name: string, repo: string, wait = false): Promise<string | null> {
  const p = load(name);
  const peer = peerOf(p, repo);
  if (!await sh("sh", ["-c", "command -v ctags"], { ok: true })) return null;
  const dir = indexDir(name, repo);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "tags.tmp");
  // A checkout: what git tracks or would (build trees and scratch stay out). Anything else, a
  // home directory say: a bounded walk that skips hidden directories.
  const files = `{ git ls-files -co --exclude-standard 2>/dev/null || find . -name '.?*' -prune -o -type f -print | sed 's|^\\./||' | head -n 20000; }`;
  const script = `cd ${shq(peer.path)} && ${files} | ctags ${CTAGS_ARGS.map(shq).join(" ")} -L - -f ${shq(tmp)} >/dev/null 2>&1 && mv -f ${shq(tmp)} ${shq(join(dir, "tags"))} && (git rev-parse --short HEAD 2>/dev/null || echo -) > ${shq(join(dir, "rev"))}`;
  if (wait) await Bun.spawn(["sh", "-c", script], { stdio: ["ignore", "ignore", "ignore"] }).exited;
  else Bun.spawn(["sh", "-c", script], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  return join(dir, "tags");
}

export async function indexAll(name: string, wait = false): Promise<string[]> {
  return (await Promise.all(load(name).peers.map((x) => index(name, x.repo, wait)))).filter((x): x is string => !!x);
}

export async function addPeer(name: string, path: string, o: { role?: Role; model?: string | null; repo?: string; origin?: string; branch?: string } = {}): Promise<Peer> {
  const p = load(name);
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isDirectory()) throw new Error();
  } catch {
    die(`not a directory: ${path}`);
  }
  const repo = o.repo ?? basename(real);
  if (!NAME_RE.test(repo)) die(`bad peer name '${repo}'`);
  if (p.peers.some((x) => x.repo === repo)) die(`peer '${repo}' already in ${name}`);
  if (p.peers.some((x) => x.path === real)) die(`${real} already in ${name}`);
  // Nobody leads until the user says so (setLead); an explicit lead demotes the old one.
  const role: Role = o.role ?? "peer";
  if (role === "lead") {
    p.lead = repo;
    for (const x of p.peers) x.role = "peer";
  }
  // An existing checkout keeps its history: its newest conversation becomes the peer's.
  const peer: Peer = { repo, path: real, role, model: o.model ?? null, session: latestSession(real) ?? crypto.randomUUID() };
  if (o.origin) { peer.origin = o.origin; if (o.branch) peer.branch = o.branch; }
  trustPath(real);
  p.peers.push(peer);
  save(p);
  if (await tmux.sessionUp(name)) await spawn(p, peer);
  void syncGroup(p).then(() => tellGroup(p, `${repo} joined the project at ${real}; it starts when the project is next brought up or added while up.`));
  return peer;
}

// A project's claude-peers group, prefixed: peers are named after repos, so a project named
// like one of its repos would otherwise collide with that peer.
export const GROUP = (name: string) => `mc-${name}`;

// Resync and say so when the broker refused: a group that silently stays stale sends
// messages to the wrong sessions.
export async function syncGroupNow(name: string): Promise<void> {
  if (!exists(name)) return;
  const err = await syncGroup(load(name));
  if (err) console.error(`my-claude: claude-peers group ${GROUP(name)} not updated: ${err}`);
}

// Running sessions learn roster changes by message; their system prompt is a snapshot.
async function tellGroup(p: Project, text: string): Promise<void> {
  if (p.peers.length && peers.available() && (await tmux.sessionUp(p.name))) void peers.broadcast(GROUP(p.name), `[my-claude] project "${p.name}": ${text}`);
}

// The project's claude-peers group holds every peer, addressed by path. Resolves to the
// broker's complaint when it refused, null when fine or when there is no broker CLI.
export async function syncGroup(p: Project): Promise<string | null> {
  if (!peers.available()) return null;
  const human = chatMember(p.name);
  const members = [...p.peers.map((x) => x.path), ...(human ? [human] : [])];
  const r = await (p.peers.length ? peers.setGroup(GROUP(p.name), members) : peers.deleteGroup(GROUP(p.name)));
  return r.ok || !p.peers.length ? null : r.out.split("\n")[0];
}

// The user's name in the chat (prefix+c), not the bare user name: a session in $HOME has that.
// The marker carries the chat's pid, so a crashed chat leaves no ghost member.
export const CHAT_NAME = (): string => (config().chat?.name as string | undefined) ?? `${process.env.USER ?? "user"}-chat`;
const chatMarker = (name: string) => join(PROJECTS, name, ".my-claude", "chat.json");
function chatMember(name: string): string | null {
  try {
    const m = JSON.parse(readFileSync(chatMarker(name), "utf8")) as { who: string; pid: number };
    process.kill(m.pid, 0);
    return m.who;
  } catch {
    return null;
  }
}

// prefix+c from any pane of a project: a chat with the whole group (one per project; a
// second press focuses the one that is up).
export async function chat(): Promise<string | null> {
  const at = await tmux.activePeer();
  if (!at) die("not in a my-claude project pane");
  return await openChat(at.name);
}

// The chat pane, opened when there is none. solo: its own window (its pane id is returned for
// the app to show); grid: a float over the calling client's window (null).
export async function openChat(name: string): Promise<string | null> {
  const p = load(name);
  const role = `chat:${name}`;
  const up = (await tmux.panes(name)).find((x) => tmux.label(x) === role);
  if (p.layout === "solo") return up?.id ?? await tmux.shellWindow(name, `${CLI} _chat ${name}`, role);
  if (up) { await sh("tmux", ["select-pane", "-t", up.id], { ok: true }); if (up.height <= tmux.MIN_H) await tmux.restoreFloat(name, up.id); return null; }
  await tmux.shellOverActive(`${CLI} _chat ${name}`, role, 0);
  await tmux.tile(name);
  return null;
}

// Each peer's colour in the chat: the project's hue stepped round per peer, bright enough for a
// dark terminal; a pane with a scheme of its own keeps the project hue, like its header.
export function peerColors(p: Project): Record<string, string> {
  const base = projectColor(p.name, p.color).ink;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(base);
  const [r, g, b] = m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [0.4, 0.6, 1];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const hsl = (H: number, S: number, L: number) => {
    const C = (1 - Math.abs(2 * L - 1)) * S, X = C * (1 - Math.abs(((H / 60) % 2) - 1)), mm = L - C / 2;
    const [R, G, B] = H < 60 ? [C, X, 0] : H < 120 ? [X, C, 0] : H < 180 ? [0, C, X] : H < 240 ? [0, X, C] : H < 300 ? [X, 0, C] : [C, 0, X];
    return "#" + [R, G, B].map((v) => Math.round((v + mm) * 255).toString(16).padStart(2, "0")).join("");
  };
  return Object.fromEntries(p.peers.map((x, i) => [x.repo, hsl((h + i * 137.5) % 360, 0.75, 0.68)]));
}

export async function chatPane(name: string): Promise<number> {
  const p = load(name);
  const who = CHAT_NAME();
  mkdirSync(join(PROJECTS, name, ".my-claude"), { recursive: true });
  writeFileSync(chatMarker(name), JSON.stringify({ who, pid: process.pid }));
  // The chat blocks this process, so the group work runs as subprocesses, not promises.
  const sync = () => Bun.spawnSync([CLI, "_sync-group", name]);
  sync();
  if (p.peers.length && await tmux.sessionUp(name)) peers.broadcastSync(GROUP(name), `[my-claude] project "${name}": ${who} (the user) joined the chat as peer "${who}"; messages from that name are from the user.`);
  console.log(`my-claude: chatting with ${p.peers.map((x) => x.repo).join(", ") || "nobody yet"} in "${name}". Ctrl-D leaves.\n`);
  let rc = 1;
  try {
    rc = peers.chat(GROUP(name), who, join(PROJECTS, name), peerColors(p));
  } finally {
    rmSync(chatMarker(name), { force: true });
    sync();
  }
  return rc;
}

// "Add repo", one line: a path (symlinked in), or <repo> / <org>/<repo> / a git URL (cloned,
// --branch B), or a GitHub PR URL (its head branch).
export interface RepoSpec {
  kind: "path" | "clone";
  path?: string; // kind=path
  repo: string; // org/name for clone, basename for path
  branch?: string;
  display: string;
  url?: boolean; // repo is a git URL, not a GitHub owner/name
}

export async function parseRepoSpec(line: string): Promise<RepoSpec & { name?: string }> {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) die("nothing to add");
  let branch: string | undefined, name: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--branch" || words[i] === "-b") branch = words[++i] ?? die("--branch needs a value");
    else if (words[i] === "--name") name = words[++i] ?? die("--name needs a value");
    else pos.push(words[i]);
  }
  if (pos.length !== 1) die(`one path, repo or url please (got: ${pos.join(" ")})`);
  const t = pos[0].replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  // A path is spelled like one (/, ./, ../ or ~); a bare word is always a repo to clone,
  // even when a directory of that name happens to sit in the cwd.
  const spelledPath = /^(\/|\.\.?\/)/.test(t) || pos[0].startsWith("~");
  if (spelledPath || (t.includes("/") && !/^[\w.-]+\/[\w.-]+$/.test(t) && existsSync(t))) {
    if (!existsSync(t)) die(`no such directory: ${pos[0]}`);
    return { kind: "path", path: realpathSync(t), repo: basename(realpathSync(t)), display: t, name };
  }
  const pr = t.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (pr) {
    const info = JSON.parse(await sh("gh", ["pr", "view", pr[2], "--repo", pr[1], "--json", "headRefName,headRepository,headRepositoryOwner"]));
    const repo = `${info.headRepositoryOwner?.login ?? pr[1].split("/")[0]}/${info.headRepository?.name ?? pr[1].split("/")[1]}`;
    return { kind: "clone", repo, branch: info.headRefName, display: `${repo}#${info.headRefName} (PR ${pr[2]})`, name };
  }
  const url = t.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (url) return { kind: "clone", repo: url[1], branch, display: url[1] + (branch ? `#${branch}` : ""), name };
  // any other git URL (another forge, a server of your own): cloned with git itself
  if (/^(?:https?|ssh|git|file):\/\/\S+$/.test(t) || /^[\w.-]+@[\w.-]+:\S+$/.test(t)) {
    const base = t.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop()!;
    return { kind: "clone", repo: `${t.replace(/\/+$/, "")}`, url: true, branch, display: t + (branch ? `#${branch}` : ""), name: name ?? base };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return { kind: "clone", repo: t, branch, display: t + (branch ? `#${branch}` : ""), name };
  if (/^[\w.-]+$/.test(t)) {
    const org = config().clone?.defaultOrg ?? die(`'${t}' is not a path; set clone.defaultOrg in settings.json to clone <org>/${t}`);
    return { kind: "clone", repo: `${org}/${t}`, branch, display: `${org}/${t}` + (branch ? `#${branch}` : ""), name };
  }
  die(`don't know what to do with '${t}'`);
}

// "libfoo --branch dev <pr url> ../" -> one spec per repo; flags bind to the spec before them.
export function splitRepoSpecs(line: string): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const groups: string[][] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--branch" || w === "-b" || w === "--name") {
      if (!groups.length) die(`${w} before any repo`);
      groups[groups.length - 1].push(w, words[++i] ?? die(`${w} needs a value`));
    } else groups.push([w]);
  }
  return groups.map((g) => g.join(" "));
}

// Add every spec on the line, in order; stops at the first failure.
export async function addRepos(name: string, line: string, o: { role?: Role; model?: string | null; log?: (s: string) => void } = {}): Promise<Peer[]> {
  const added: Peer[] = [];
  for (const spec of splitRepoSpecs(line)) added.push(await addRepo(name, spec, { ...o, role: added.length ? undefined : o.role }));
  return added;
}

// Resolve the spec into a directory under the project tree, cloning if needed, then register it.
export async function addRepo(name: string, line: string, o: { role?: Role; model?: string | null; log?: (s: string) => void } = {}): Promise<Peer> {
  const p = load(name);
  const spec = await parseRepoSpec(line);
  const repo = spec.name ?? (spec.kind === "path" ? spec.repo : spec.repo.split("/")[1].replace(/\.git$/, ""));
  if (!NAME_RE.test(repo)) die(`bad peer name '${repo}'`);
  if (p.peers.some((x) => x.repo === repo)) die(`peer '${repo}' already in ${name}`);
  const slot = join(PROJECTS, name, repo);
  const st = lstatSync(slot, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) unlinkSync(slot); // a link left by a removed peer; harmless to replace
  let path: string;
  if (spec.kind === "path") {
    if (st && !st.isSymbolicLink()) die(`${slot} is a clone from an earlier peer; remove it or add it as a path`);
    path = spec.path!;
    symlinkSync(path, slot);
  } else if (st && !st.isSymbolicLink()) {
    // A clone left behind by a removed peer: reuse it, switch branch if asked.
    const origin = await sh("git", ["-C", slot, "remote", "get-url", "origin"], { ok: true });
    if (!origin.includes(spec.repo)) die(`${slot} exists and is not a clone of ${spec.repo} (origin ${origin || "?"})`);
    if (spec.branch) {
      if (await sh("git", ["-C", slot, "status", "--porcelain"], { ok: true })) die(`${slot} has uncommitted changes; commit or stash before switching to ${spec.branch}`);
      o.log?.(`reusing clone, switching to ${spec.branch}...`);
      const proc = Bun.spawn(["bash", "-c", 'git fetch origin "$1" && git checkout "$1" && git pull --ff-only origin "$1"', "git", spec.branch], { cwd: slot, stdout: "pipe", stderr: "pipe" });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) die(`switch to ${spec.branch} failed: ${err.trim().split("\n").pop()}`);
    } else o.log?.(`reusing existing clone at ${slot}`);
    path = slot;
  } else {
    o.log?.(`cloning ${spec.display}...`);
    const failed = await clone(spec.repo, slot, spec.branch);
    if (failed) die(`clone failed: ${failed}`);
    path = slot;
  }
  return await addPeer(name, path, { role: o.role, model: o.model, repo, ...(spec.kind === "clone" ? { origin: spec.repo, branch: spec.branch } : {}) });
}

export async function rmPeer(name: string, repo: string): Promise<string> {
  const p = load(name);
  const peer = peerOf(p, repo);
  p.peers = p.peers.filter((x) => x.repo !== repo);
  // Remembered so it can come back (readd) with the same path and conversation.
  p.removed = [...(p.removed ?? []).filter((x) => x.repo !== repo), { ...peer, when: Date.now() }].slice(-20);
  clearAttention(name, repo);
  if (p.lead === repo) p.lead = null;
  save(p);
  void syncGroup(p).then(() => tellGroup(p, `${repo} left the project; its session is gone.`));
  await refreshStatus(p);
  // Its pane (and the claude in it) goes too: the peer is no longer part of the project.
  if (await tmux.sessionUp(name)) {
    const pane = await tmux.paneOf(name, repo);
    if (pane) {
      await killOccupant(peer.path);
      await tmux.killPane(pane);
    }
    await closeShellPanes(name, repo);
  }
  const slot = join(PROJECTS, name, repo);
  const st = lstatSync(slot, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    unlinkSync(slot);
    return "link removed";
  }
  return st ? `clone left at ${slot}` : "";
}

// Real (non-symlink) repo dirs under the project tree: fresh clones that may hold work.
export function clonesOf(name: string): string[] {
  const dir = join(PROJECTS, name);
  if (!existsSync(dir)) return [];
  // .my-claude holds the symbol indexes, my-claude's own, not a clone.
  return readdirSync(dir).filter((f) => {
    if (f === ".my-claude") return false;
    const st = lstatSync(join(dir, f));
    return st.isDirectory() && !st.isSymbolicLink();
  });
}

export function setGoal(name: string, goal: string): void {
  const p = load(name);
  p.goal = goal;
  save(p);
}

// A lead comes with the goal. Both are briefed through claude-peers: the lead gets
// the goal and the roster, every other peer gets who leads and what for.
export async function setLead(name: string, repo: string, goal?: string): Promise<string[]> {
  const p = load(name);
  peerOf(p, repo);
  p.lead = repo;
  if (goal !== undefined) p.goal = goal;
  for (const x of p.peers) x.role = x.repo === repo ? "lead" : "peer";
  save(p);
  await refreshStatus(p);
  return brief(p);
}

export async function brief(p: Project): Promise<string[]> {
  if (!p.lead) die(`${p.name} has no lead`);
  if (!peers.available()) return ["claude-peers CLI not found; briefs not sent"];
  const lead = peerOf(p, p.lead);
  const roster = p.peers.map((x) => `${x.repo} (${x.path})${x.repo === p.lead ? " [lead]" : ""}`).join(", ");
  const goal = p.goal ? p.goal : "(no goal written yet)";
  const notes: string[] = [];
  const leadMsg = `You lead project "${p.name}".\nGoal: ${goal}\nPeers: ${roster}.\nThey are the claude-peers group "${GROUP(p.name)}"; message it to reach everyone, or a peer by its path. Coordinate the work across repos; you own the outcome.`;
  notes.push(`${lead.repo}: ${(await peers.send(lead.path, leadMsg)).out.split("\n")[0]}`);
  for (const x of p.peers) {
    if (x.repo === p.lead) continue;
    const msg = `You are part of project "${p.name}", working in ${x.repo} (${x.path}).\nLead: ${lead.repo} (${lead.path}); take direction from them.\nGoal: ${goal}\nThe claude-peers group "${GROUP(p.name)}" reaches everyone on the project.`;
    notes.push(`${x.repo}: ${(await peers.send(x.path, msg)).out.split("\n")[0]}`);
  }
  return notes;
}

export function setPeer(name: string, repo: string, o: { role?: Role; model?: string | null; session?: string }): void {
  const p = load(name);
  const peer = peerOf(p, repo);
  if (o.role === "lead") die("use setLead (it carries the goal and the briefs)");
  if (o.role === "peer") {
    peer.role = "peer";
    if (p.lead === repo) p.lead = null;
  }
  if (o.model !== undefined) peer.model = o.model;
  if (o.session !== undefined) {
    // Accept a prefix of an existing transcript id, like `git` does with hashes.
    const full = o.session.length === 36 ? o.session : latestMatching(peer.path, o.session);
    if (!existsSync(transcriptPath(peer.path, full))) die(`no transcript ${full} for ${peer.path}`);
    peer.session = full;
  }
  save(p);
}

function latestMatching(path: string, prefix: string): string {
  const dir = transcriptDir(path);
  const hits = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")) : [];
  if (hits.length !== 1) die(`${hits.length} conversations match '${prefix}' in ${dir}`);
  return hits[0].replace(/\.jsonl$/, "");
}

export async function deleteProject(name: string, force = false): Promise<string> {
  load(name);
  const clones = clonesOf(name);
  if (clones.length && !force) die(`${name} has cloned repos (${clones.join(", ")}); use --force (they go to .trash, not rm -rf)`);
  await tmux.killSession(name);
  const dest = remove(name);
  if (peers.available()) void peers.deleteGroup(GROUP(name));
  return dest;
}

// owner/name: gh when logged in (private repos, the user's protocol), else git over https
// (public, no login), else ssh (your key); any other URL: git. Null when cloned, else why not.
async function clone(origin: string, path: string, branch?: string): Promise<string | null> {
  const run = async (argv: string[]): Promise<string | null> => {
    try {
      const key = String(config().clone?.sshKey ?? "").replace(/^~/, homedir());
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(key ? { GIT_SSH_COMMAND: `ssh -i ${shq(key)} -o IdentitiesOnly=yes` } : {}) };
      const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe", env });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return code === 0 ? null : err.trim().split("\n").pop() || `${argv[0]} exited ${code}`;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const git = (url: string) => run(["git", "clone", ...(branch ? ["--branch", branch] : []), url, path]);
  if (!/^[\w.-]+\/[\w.-]+$/.test(origin)) return git(origin);
  const tries: (() => Promise<string | null>)[] = [];
  if (Bun.which("gh") && (await shOk("gh", ["auth", "status"]))) {
    tries.push(() => run(["gh", "repo", "clone", origin, path, ...(branch ? ["--", "--branch", branch] : [])]));
  }
  tries.push(() => git(`https://github.com/${origin}.git`), () => git(`git@github.com:${origin}.git`));
  let why: string | null = "no way to clone";
  for (const t of tries) {
    why = await t();
    if (!why) return null;
    rmSync(path, { recursive: true, force: true }); // a half-made clone must not stop the next try
  }
  return why;
}

// Put a removed peer back: same repo name, path and conversation. A clone that went to
// .trash with the peer, or was never there, is cloned again from its origin.
export async function readd(name: string, repo: string, log?: (s: string) => void): Promise<Peer> {
  const p = load(name);
  const r = (p.removed ?? []).find((x) => x.repo === repo);
  if (!r) die(`${repo} was not removed from ${name} (have: ${(p.removed ?? []).map((x) => x.repo).join(", ") || "none"})`);
  if (p.peers.some((x) => x.repo === repo)) die(`peer '${repo}' already in ${name}`);
  if (!existsSync(r.path)) {
    if (!r.origin) die(`${r.path} is gone and ${repo} has no origin to clone from`);
    log?.(`cloning ${r.origin}${r.branch ? "#" + r.branch : ""} -> ${r.path}...`);
    const failed = await clone(r.origin, r.path, r.branch);
    if (failed) die(`clone of ${r.origin} failed: ${failed}`);
  }
  const slot = join(PROJECTS, name, repo);
  const st = lstatSync(slot, { throwIfNoEntry: false });
  if (!st && realpathSync(r.path) !== slot) symlinkSync(r.path, slot);
  const { when: _when, ...peer } = r;
  peer.role = "peer";
  trustPath(peer.path);
  p.peers.push(peer);
  p.removed = (p.removed ?? []).filter((x) => x.repo !== repo);
  save(p);
  if (await tmux.sessionUp(name)) await spawn(p, peer);
  void syncGroup(p).then(() => tellGroup(p, `${repo} is back in the project at ${peer.path}, same conversation as before.`));
  return peer;
}

export async function undelete(which: string, log?: (s: string) => void): Promise<{ name: string; recloned: string[]; missing: string[] }> {
  const p = restore(which);
  const recloned: string[] = [], missing: string[] = [];
  for (const peer of p.peers) {
    if (existsSync(peer.path)) continue;
    if (peer.origin && peer.path.startsWith(join(PROJECTS, p.name) + "/")) {
      log?.(`cloning ${peer.origin}${peer.branch ? "#" + peer.branch : ""} -> ${peer.path}...`);
      const failed = await clone(peer.origin, peer.path, peer.branch);
      if (!failed) { recloned.push(peer.repo); trustPath(peer.path); continue; }
      log?.(`clone of ${peer.origin} failed: ${failed}`);
    }
    missing.push(`${peer.repo} (${peer.path})`);
  }
  return { name: p.name, recloned, missing };
}

// A whole project in one go, as the MCP tool does it: create, add repos, lead with the
// work order as goal and first prompt, bring it up.
export async function startProject(o: { name: string; repos: string[]; workOrder: string; lead?: string; color?: string; shared?: boolean; by?: string; ticket?: string }): Promise<{ name: string; peers: string[]; lead: string; notes: string[] }> {
  const name = slug(o.name);
  if (!name) die(`bad project name '${o.name}'`);
  if (!o.repos?.length) die("at least one repo");
  if (!o.workOrder?.trim()) die("a work order is required: the lead sees nothing else");
  const p = newProject(name, { goal: o.workOrder, shared: o.shared, color: o.color, ticket: o.ticket });
  if (o.by) { p.by = o.by; save(p); }
  const notes: string[] = [];
  const added: Peer[] = [];
  for (const spec of o.repos) added.push(...(await addRepos(name, spec, { log: (m) => notes.push(m) })));
  const lead = o.lead ?? added[0].repo;
  const q = load(name);
  const lp = peerOf(q, lead);
  lp.kickoff = o.workOrder;
  q.lead = lead;
  for (const x of q.peers) x.role = x.repo === lead ? "lead" : "peer";
  save(q);
  const bin = await ensureBinary();
  if (bin) notes.push(bin);
  for (const r of await up(name)) if (r.action === "skipped") notes.push(`${r.repo}: skipped, ${r.detail}`);
  return { name, peers: q.peers.map((x) => x.repo), lead, notes };
}

async function spawn(p: Project, peer: Peer): Promise<string> {
  const prof = profile(p.profile);
  const env = { MY_CLAUDE_ROOT: ROOT, MY_CLAUDE_PROJECT: p.name, MY_CLAUDE_PEER: peer.repo, ...prof.paneEnv(p.name, peer.repo) };
  const pane = await tmux.spawnPane(p.name, peer.repo, peer.path, env, `${CLI} _launch ${p.name} ${peer.repo}`);
  await index(p.name, peer.repo);
  // Every window (a spill-over tab included) gets its panel; a no-op where one exists,
  // and in the solo layout (the native app lists the projects itself).
  if (config().panel !== false) await tmux.openPanel(p.name, CLI, false);
  await refreshStatus(p);
  return pane;
}

// grid <-> solo, for the record and for the running session.
export async function setLayout(name: string, to: Layout): Promise<Layout> {
  const p = load(name);
  if ((p.layout ?? "grid") !== to) {
    if (to === "grid") delete p.layout;
    else p.layout = to;
    save(p);
  }
  if (await tmux.sessionUp(name)) {
    await tmux.relayout(name, to);
    if (to === "grid" && config().panel !== false) await tmux.openPanel(name, CLI, false);
    await refreshStatus(p);
  }
  return to;
}

// prefix+`: focus the side panel of the client's project session, opening it if closed.
export async function panel(): Promise<void> {
  const s = await tmux.currentSession();
  if (!s?.startsWith("mc-")) die("not in a my-claude project session");
  await tmux.openPanel(s.slice(3), CLI, true);
}

export const cycle = tmux.cycle;

export async function refreshStatus(p: Project): Promise<void> {
  await tmux.applyStatus(p.name, p.peers.map((x) => ({ repo: x.repo, lead: x.repo === p.lead })), projectColor(p.name, p.color).tmux, CLI);
}

export async function setColor(name: string, color: string): Promise<void> {
  if (!PALETTE[color]) die(`no color '${color}' (have: ${Object.keys(PALETTE).join(", ")})`);
  const p = load(name);
  p.color = color;
  save(p);
  await refreshStatus(p);
}

export interface UpReport {
  repo: string;
  action: "live" | "starting" | "launched" | "relaunched" | "skipped" | "closed";
  detail?: string;
}

// Idempotent: launches only what is missing, never touches a live or stranger-held repo.
export async function up(name: string): Promise<UpReport[]> {
  if (existsSync("/.dockerenv")) die("up runs on the host, not in a container");
  const p = load(name);
  if (p.peers.length === 0) die(`${name} has no peers (my-claude add)`);
  profile(p.profile);
  if (!p.running) save({ ...p, running: true });
  const report: UpReport[] = [];
  for (const peer of p.peers) {
    const st = await peerState(p, peer);
    if (st === "live" || st === "starting") report.push({ repo: peer.repo, action: st });
    else if (st === "idle") {
      await relaunchInPane(p, peer, (await tmux.paneOf(name, peer.repo))!);
      report.push({ repo: peer.repo, action: "relaunched" });
    } else if (st === "occupied") {
      const lock = lockInfo(peer.path);
      report.push({ repo: peer.repo, action: "skipped", detail: `pid ${occupantPid(peer.path)}${lock?.started ? `, since ${String(lock.started).slice(11, 16)}` : ""}` });
    } else {
      await spawn(p, peer);
      report.push({ repo: peer.repo, action: "launched" });
    }
  }
  if (!await tmux.sessionUp(name)) {
    const held = report.filter((r) => r.action === "skipped");
    die(held.map((r) => `${r.repo}: its conversation is open in a Claude started outside my-claude (${r.detail}); to move it here: my-claude takeover ${name} ${r.repo}`).join("\n") || "nothing launched");
  }
  // Panes for repos that are no longer peers (removed while the session was down, or
  // a record edited by hand): my-claude made them, my-claude closes them.
  for (const s of await strayPanes(p)) {
    await tmux.killPane(s.id);
    report.push({ repo: s.title, action: "closed", detail: "no longer a peer" });
  }
  void syncGroup(p);
  return report;
}

// Panes in the project window whose title is neither a peer nor a shell on one.
export async function strayPanes(p: Project): Promise<{ id: string; title: string }[]> {
  if (!await tmux.sessionUp(p.name)) return [];
  const known = new Set([tmux.PANEL_TITLE, `chat:${p.name}`, ...p.peers.flatMap((x) => [x.repo, `shell:${x.repo}`, `host:${x.repo}`])]);
  return (await tmux.docked(p.name)).filter((x) => !known.has(tmux.label(x))).map((x) => ({ id: x.id, title: tmux.label(x) }));
}

async function closeShellPanes(name: string, repo: string): Promise<void> {
  for (const x of await tmux.panes(name)) if (shellRepo(tmux.label(x)) === repo) await tmux.killPane(x.id);
}

export async function down(name: string): Promise<boolean> {
  const p = load(name);
  if (p.running) save({ ...p, running: false }); // brought down on purpose: auto-restart leaves it
  if (!await tmux.sessionUp(name)) return false;
  await tmux.killSession(name);
  return true;
}

export async function attach(name: string, repo?: string): Promise<number> {
  const p = load(name);
  if (!await tmux.sessionUp(name)) die(`project '${name}' is not up (my-claude up ${name})`);
  // Left in the window's layout with no window showing it: back to the tiled layout, which
  // follows this terminal's size (a window that opens it takes it back).
  if (p.layout === "solo") {
    const clients = await sh("tmux", ["list-clients", "-t", `=${tmux.sess(name)}`, "-F", "#{client_control_mode}"], { ok: true });
    if (!clients.split("\n").includes("1")) await setLayout(name, "grid");
  }
  return await tmux.attach(name, repo ?? p.lead ?? p.peers[0]?.repo);
}

export async function restart(name: string, repo: string): Promise<void> {
  const p = load(name);
  const peer = peerOf(p, repo);
  if (await peerState(p, peer) === "occupied") die(`${repo} is occupied by a stranger; use takeover`);
  if (!await killOccupant(peer.path)) die(`could not stop ${repo}`);
  const pane = await tmux.paneOf(name, repo);
  if (pane) {
    await pause(1500); // let the shell take the prompt back before typing into it
    await relaunchInPane(p, peer, pane);
  } else await spawn(p, peer);
}

export async function takeover(name: string, repo: string): Promise<void> {
  const p = load(name);
  const peer = peerOf(p, repo);
  if ((await peerState(p, peer)) !== "occupied") die(`${repo} is not occupied by a stranger`);
  if (!await killOccupant(peer.path)) die(`could not stop the session on ${peer.path}`);
  await spawn(p, peer);
}

// One look at tmux and one at /proc, whatever the number of peers.
export async function status(name: string): Promise<ProjectStatus> {
  const p = load(name);
  const up = await tmux.sessionUp(name);
  const rows = up ? await tmux.panes(name) : [];
  const pidOf = occupantsIndex();
  const now = Math.floor(Date.now() / 1000);
  const peers: PeerStatus[] = p.peers.map((peer) => {
    const pane = tmux.peerPane(rows, peer.repo);
    const pid = pidOf(peer.path);
    return { ...peer, state: peerStateOf(pane ? Math.max(0, now - pane.start) : null, pid), pane: pane?.id ?? null, pid, lock: lockInfo(peer.path), attn: attention(name, peer.repo) };
  });
  const state: ProjectState = !up ? "DOWN" : peers.every((x) => x.state === "live") ? "UP" : "PARTIAL";
  return { ...p, state, peers, strays: (await strayPanes(p)).map((x) => x.title) };
}

export async function ls(): Promise<ProjectRow[]> {
  return Promise.all(listProjects().map(async (p) => {
    let last = 0;
    for (const peer of p.peers) {
      try {
        last = Math.max(last, Math.floor(statSync(transcriptPath(peer.path, peer.session)).mtimeMs / 1000));
      } catch {
        /* no transcript yet */
      }
    }
    return { name: p.name, peers: p.peers.length, lead: p.lead, mode: p.mode, profile: p.profile, goal: p.goal, color: p.color ?? null, state: await projectState(p), attn: projectAttention(p.name, p.peers.map((x) => x.repo)), last_used: last };
  }));
}

// Everything the native app draws, in one pass: one tmux call per running project and one
// scan of /proc for all of them (status() per project would scan it once per peer).
export interface PeerSnap extends Peer { state: PeerState; pane: string | null; attn: Attention }
export interface ProjectSnap { project: Project; up: boolean; state: ProjectState; color: string; attn: Attention; peers: PeerSnap[]; panes: tmux.PaneRow[] }
export async function snapshot(): Promise<ProjectSnap[]> {
  const pidOf = occupantsIndex();
  const now = Math.floor(Date.now() / 1000);
  const sessions = new Set(await tmux.projectSessions());
  return Promise.all(listProjects().map(async (p) => {
    const up = sessions.has(tmux.sess(p.name));
    const rows = up ? await tmux.panes(p.name) : [];
    const peers: PeerSnap[] = p.peers.map((peer) => {
      const pane = tmux.peerPane(rows, peer.repo);
      return { ...peer, state: peerStateOf(pane ? Math.max(0, now - pane.start) : null, pidOf(peer.path)), pane: pane?.id ?? null, attn: attention(p.name, peer.repo) };
    });
    const state: ProjectState = !up ? "DOWN" : peers.every((x) => x.state === "live") ? "UP" : "PARTIAL";
    const attn: Attention = peers.some((x) => x.attn === "ask") ? "ask" : peers.some((x) => x.attn === "wait") ? "wait" : null;
    return { project: p, up, state, color: projectColor(p.name, p.color).ink, attn, peers, panes: rows };
  }));
}

// `MY_CLAUDE_PROJECT=x MY_CLAUDE_PEER=y claude <args>` for a shell inside the peer's environment.
export function claudeLine(name: string, peer: Peer, args: string[]): string {
  return [`MY_CLAUDE_PROJECT=${shq(name)}`, `MY_CLAUDE_PEER=${shq(peer.repo)}`, "claude", ...args.map(shq)].join(" ");
}

// What a peer knows from its first token. Claude Code keeps a conversation's system prompt,
// so this is the starting picture; roster changes travel as briefs.
export function projectBrief(p: Project, peer: Peer): string {
  const others = p.peers.filter((x) => x.repo !== peer.repo);
  const who = (x: Peer) => `${x.repo} (${x.path})${x.repo === p.lead ? ", the lead" : ""}`;
  const lines = [
    `You are one of ${p.peers.length} Claude Code sessions working together on the project "${p.name}", managed by my-claude. Yours is ${peer.repo} at ${peer.path}${peer.repo === p.lead ? "; you lead the project" : ""}.`,
    others.length
      ? `The other sessions, each in its own repo: ${others.map(who).join("; ")}. They are live now or will be shortly, and they know about you.`
      : "No other session is on the project yet; more may be added.",
    p.lead ? (peer.repo === p.lead ? "You own the outcome: coordinate the work across repos." : `${p.lead} leads; take direction from them.`) : "Nobody leads yet; coordinate as equals.",
    p.goal ? `Goal: ${p.goal}` : "",
    p.ticket ? `Ticket: ${p.ticket}. The project exists for it; reference it in branches, commits and PRs the way the repo's conventions want.` : "",
    p.by ? `This project was started by the Claude session ${p.by} on the user's behalf; it is a claude-peers peer, report results back to it as well as to the user.` : "",
    `Everyone is in the claude-peers group "${GROUP(p.name)}": message the group to reach all of them, or one peer by its path (paths are unambiguous; a repo name can carry a suffix like -2 when the same repo is open in another project). When your work touches another repo, or you need something from it, talk to that session instead of guessing or editing it yourself; tell the group when you change an interface others build against. "Work with your peers" means exactly this. The roster above is from your launch; the my-claude MCP tool project_status gives the current one.`,
    `Need more hands or a separate line of work (a new idea, a change in other repos, anything that should outlive this conversation)? Do not spawn subagents for it: call the my-claude MCP tool start_project with the repos and a written work order. That gives it durable sessions the user sees and can talk to in the side panel. add_repos brings another repo into a project as a peer of its own (into this one too, when the user asks, e.g. add_repos with project "${p.name}" and repos ["concourse-pipelines"]). Repos are given as a path, a bare name (cloned from the default org), org/repo, or a git or PR URL; anything not on disk is cloned fresh. list_projects and project_status show what exists.`,
    `The user can join the group as the claude-peers peer "${CHAT_NAME()}" (a chat pane, prefix+c). A message from that name is from the user, in person: treat it as you would a prompt. Answer in the group so the user and every peer see it, and keep it to the point; the user reads it in a small pane.`,
    `The project is the tmux session "${tmux.sess(p.name)}", one pane per session titled with its repo name (yours: "${peer.repo}"), spread over its windows when there are many; a shell the user opened beside a peer is titled "shell:<repo>" (in that peer's environment) or "host:<repo>" (on the host), the user's chat pane "chat:${p.name}", and "${tmux.PANEL_TITLE}" is the project list. You can read any pane, e.g. when asked what another peer or a build shell is showing: find it with \`tmux list-panes -s -t ${tmux.sess(p.name)} -F '#{pane_id} #{pane_title}'\`, then \`tmux capture-pane -p -J -S -200 -t <pane_id>\` (reading only; do not type into another pane).`,
    `Symbol index: ${indexFile(p.name, peer.repo)} is a universal-ctags file over your checkout, rebuilt in the background each time your session starts (git-tracked and untracked-unignored files, paths relative to the repo root; sibling file "rev" holds the commit it was built from). Look up an API before writing or guessing: \`grep -P '^Name\\t' <tags>\` gives declaration file, pattern, kind and, as extra fields, line:, the enclosing namespace:/class:/struct:, signature:, inherits: and access:. \`grep -P '\\tclass:een::Foo\\t' <tags> | cut -f1 | sort -u\` lists a class's members; \`grep -P '^\\w+\\tinclude/'\` narrows to public headers. Other peers' indexes sit beside yours under ${join(PROJECTS, p.name, ".my-claude")}/<repo>/tags. Rebuild after large changes with \`${CLI} index ${p.name} ${peer.repo}\`.`,
    ...(profile(p.profile).brief?.({ project: p.name, repo: peer.repo, path: peer.path, goal: p.goal, ticket: p.ticket ?? null }) ?? []),
  ];
  return lines.filter(Boolean).join("\n");
}

function claudeArgs(name: string, peer: Peer): string[] {
  const args = [existsSync(transcriptPath(peer.path, peer.session)) ? "--resume" : "--session-id", peer.session];
  if (peer.model) args.push("--model", peer.model);
  args.push("--name", `${name}/${peer.repo}`);
  args.push("--append-system-prompt", projectBrief(load(name), peer));
  args.push("--settings", attentionSettings(name, peer.repo));
  args.push("--mcp-config", mcpConfig(ROOT, CONFIG_DIR));
  if (peer.kickoff && args[0] === "--session-id") args.push(peer.kickoff);
  return args;
}

// The pane's shell is up but claude is gone: type it back in.
async function relaunchInPane(p: Project, peer: Peer, pane: string): Promise<void> {
  await index(p.name, peer.repo);
  await tmux.sendLine(pane, claudeLine(p.name, peer, claudeArgs(p.name, peer)));
}

// A click on the status bar or a minimised shell strip; run-shell has no client of its own,
// so the binding passes the clicking one.
export async function click(range: string, client = ""): Promise<void> {
  if (range.startsWith("proj:")) await sh("tmux", ["switch-client", ...(client ? ["-c", client] : []), "-t", range.slice(5)], { ok: true });
  else if (range.startsWith("pane:")) {
    const s = await tmux.currentSession();
    if (s?.startsWith("mc-")) await tmux.restoreFloat(s.slice(3), range.slice(5));
  }
}

// The repo behind a shell's title ("shell:<repo>" in its environment, "host:<repo>" on the
// host), or null.
export const shellRepo = (title: string): string | null => (/^(shell|host):/.test(title) ? title.slice(title.indexOf(":") + 1) : null);

// prefix+h: a shell in the peer's environment; prefix+H: one on the host, in the checkout.
export async function shellHere(where: "env" | "host" = "env"): Promise<string | null> {
  const at = await tmux.activePeer();
  if (!at) die("not in a my-claude project pane");
  return await openShell(at.name, shellRepo(at.repo) ?? at.repo, where);
}

// Another shell for a peer (several may be open). solo: its own window, pane id returned;
// grid: a float over the calling client's window, offset from the last (null).
export async function openShell(name: string, repo: string, where: "env" | "host" = "env"): Promise<string | null> {
  const p = load(name);
  peerOf(p, repo);
  const role = `${where === "host" ? "host" : "shell"}:${repo}`;
  const cmd = `${CLI} _shell ${name} ${repo}${where === "host" ? " --host" : ""}`;
  if (p.layout === "solo") return await tmux.shellWindow(name, cmd, role);
  const n = (await tmux.panes(name)).filter((x) => shellRepo(tmux.label(x)) === repo && x.floating && x.height > tmux.MIN_H).length;
  await tmux.shellOverActive(cmd, role, n);
  await tmux.tile(name);
  return null;
}

// What a pane is: its project, what it is called, and whether it is a peer's own pane
// (untagged, docked, titled with a peer's repo) rather than a shell, the chat or a float.
export interface PaneFacts { name: string | null; title: string; rawTitle: string; role: string; floating: boolean; peer: boolean }
export async function paneFacts(id: string): Promise<PaneFacts> {
  const s = await sh("tmux", ["display-message", "-p", ...(id ? ["-t", id] : []), `${tmux.PROJ}\t#{@mc_role}\t#{pane_floating_flag}\t#{pane_title}`], { ok: true });
  const [sess = "", role = "", fl = "0", ...t] = s.split("\t");
  const rawTitle = t.join("\t");
  const name = sess.startsWith("mc-") && exists(sess.slice(3)) ? sess.slice(3) : null;
  const floating = fl === "1";
  const peer = !!name && !role && !floating && load(name).peers.some((x) => x.repo === rawTitle);
  return { name, title: role || rawTitle, rawTitle, role, floating, peer };
}

// prefix+x: a peer's pane removes the peer, anything else just closes. The pane id is baked
// into the confirmation, so the prompt and the action cannot mean different panes.
export async function closeAsk(id: string, client: string): Promise<void> {
  const at = await paneFacts(id);
  const prompt = at.peer ? `remove ${at.title} from the project? its session ends (y/n)` : `close ${at.title}? (y/n)`;
  await sh("tmux", ["confirm-before", ...(client ? ["-t", client] : []), "-p", prompt, `run-shell "${CLI} _close '${id}'"`], { ok: true });
}

export async function closePane(id: string): Promise<string> {
  const at = await paneFacts(id);
  if (!at.name || at.rawTitle === tmux.PANEL_TITLE) { await sh("tmux", ["kill-pane", "-t", id], { ok: true }); return "closed"; }
  if (at.peer) { const note = await rmPeer(at.name, at.rawTitle); return `removed ${at.rawTitle} from ${at.name}${note ? "; " + note : ""}`; }
  await sh("tmux", ["kill-pane", "-t", id], { ok: true });
  await tmux.tile(at.name);
  return "closed";
}

// Right click: our menu in place of tmux's, by what was clicked. Items run through the CLI,
// so the menu and the keys never disagree.
export async function contextMenu(pane: string, client: string, print = false): Promise<string[]> {
  // From a pane: what that pane is; from the status bar: the clicking client's project.
  const at0 = pane ? await paneFacts(pane) : null;
  const sess = pane ? "" : await sh("tmux", ["display-message", "-p", ...(client ? ["-c", client] : []), tmux.PROJ], { ok: true });
  const name = at0 ? at0.name : sess.startsWith("mc-") ? sess.slice(3) : null;
  const title = at0?.title ?? "";
  const floating = at0?.floating ?? false;
  const p = name && exists(name) ? load(name) : null;
  // In one of the native app's views the app does the window management: minimise and
  // zoom are its own, and another project is another of its tabs, not a client switch.
  const view = await tmux.clientView(client);
  const host = (verb: string) => `run-shell "${CLI} _host ${shq(view?.sock ?? "")} ${verb}"`;
  const items: string[] = [];
  const add = (label: string, key: string, cmd: string) => items.push(label, key, cmd);
  const sep = () => items.push("", "", "");
  const at = pane ? `select-pane -t ${pane} ; ` : "";
  const minimise = () => {
    if (view && p) add("Minimise", "m", host(`minimise ${p.name}/${pane}`));
    else if (floating) add("Minimise", "m", `run-shell "${CLI} shell-min '${pane}'"`);
  };
  if (p && title === `chat:${p.name}`) {
    minimise();
    add("Leave chat", "x", `kill-pane -t ${pane}`);
    sep();
  } else if (p && (shellRepo(title) || floating)) {
    const repo = shellRepo(title);
    if (repo) {
      add(`Another shell in ${repo}'s environment`, "h", `${at}run-shell "${CLI} shell-here"`);
      add(`Host shell in ${repo}`, "H", `${at}run-shell "${CLI} shell-here --host"`);
    }
    minimise();
    add("Close shell", "x", `kill-pane -t ${pane}`);
    sep();
  } else if (p && at0?.peer) {
    add(`Shell in ${title}'s environment`, "h", `${at}run-shell "${CLI} shell-here"`);
    add(`Host shell in ${title}`, "H", `${at}run-shell "${CLI} shell-here --host"`);
    add(`Relaunch ${title}`, "R", `run-shell "${CLI} restart ${p.name} ${title}"`);
    add("Rebuild symbol index", "i", `run-shell -b "${CLI} index ${p.name} ${title}"`);
    if (view) { add("Zoom", "z", host(`zoom ${p.name}/${pane}`)); minimise(); }
    add(`Remove ${title} from project...`, "x", `run-shell "${CLI} _close-ask '${pane}' '${client}'"`);
    sep();
  } else if (p && title === tmux.PANEL_TITLE) {
    add("Hide panel", "`", `kill-pane -t ${pane}`);
    sep();
  }
  if (p) {
    add("Chat with the peers", "c", `${at}run-shell "${CLI} chat"`);
    add("Add repo...", "a", `command-prompt -p "repo (path, org/repo, url):" "run-shell \"${CLI} add ${p.name} %%\""`);
    if (view) add("Project list", "d", host("sidebar"));
    else add(`Project list (detach)`, "d", `detach-client${client ? ` -t ${client}` : ""}`);
    sep();
  }
  for (const r of await ls()) {
    const here = r.name === name;
    add(`${here ? "• " : "  "}${r.name}${r.attn ? ` ${attentionMark(r.attn)}` : ""}`, "", here ? "" : view ? host(`tab ${r.name}`) : `switch-client${client ? ` -c ${client}` : ""} -t ${tmux.sess(r.name)}`);
  }
  if (!p) { sep(); add("Zoom", "z", `resize-pane -Z -t ${pane}`); add("Kill pane", "x", `kill-pane -t ${pane}`); }
  const args = ["display-menu", "-T", p ? ` ${p.name}${title ? ` · ${title}` : ""} ` : " my-claude ", "-x", "M", "-y", "M", ...(client ? ["-c", client] : []), ...(pane ? ["-t", pane] : []), ...items];
  if (!print) await sh("tmux", args, { ok: true });
  return args;
}

// prefix+m: minimise a floating shell to a strip. Floating is what counts, not the title (the
// shell may rewrite it); the pane id is passed, run-shell's current pane may not be the float.
export async function shellMinimise(id = ""): Promise<void> {
  const pane = id || await sh("tmux", ["display-message", "-p", "#{pane_id}"], { ok: true });
  const at = await paneFacts(pane);
  if (!at.name || !at.floating) die("not in a floating my-claude pane");
  const name = at.name;
  await tmux.minimiseFloat(name, pane);
  // Focus leaves the strip: the shell's peer, or for anything else the window's first docked pane.
  const back = (shellRepo(at.title) ? await tmux.paneOf(name, shellRepo(at.title)!) : null)
    ?? (await tmux.docked(name)).find((x) => x.winActive && x.title !== tmux.PANEL_TITLE)?.id;
  if (back) await sh("tmux", ["select-pane", "-t", back], { ok: true });
}

// Runs in the new pane: the peer's environment (its container, found through its claude),
// or a host shell in the checkout before that or on request.
export function shellPane(name: string, repo: string, host = false): number {
  const p = load(name);
  const peer = peerOf(p, repo);
  const where = peer.path.replace(homedir(), "~");
  const pid = host ? null : occupantPid(peer.path);
  const container = pid ? containerOf(pid) : null;
  const prof = profile(p.profile);
  if (!host && !container && p.profile !== "host") console.log(`my-claude: ${repo}'s environment is not up yet (no claude running in it), so this is a host shell.`);
  if (host || !container) {
    console.log(`my-claude: host shell in ${name}/${repo}  ${where}`);
    return spawnSync(hostShell().shell, hostShell().args, { stdio: "inherit", cwd: peer.path, env: { ...process.env, MY_CLAUDE_PROJECT: name, MY_CLAUDE_PEER: repo } }).status ?? 1;
  }
  console.log(`my-claude: shell in ${name}/${repo} (container ${container.slice(0, 12)})  ${where}`);
  return prof.shellInto(container, peer.path);
}

// The shell for "a shell on this machine": a login shell unless config says otherwise.
const hostShell = () => loginShell(config().shell?.login !== false);

export const pauseFor = (ms: number) => pause(ms);

// Auto-restart (daemon.autoRestart): what was up and not brought down on purpose comes back,
// after a reboot or a killed tmux server, on the same conversations.
export async function keepalive(once = false): Promise<number> {
  for (;;) {
    if (daemonSettings().autoRestart) {
      for (const { name } of listProjects()) {
        try {
          const p = load(name);
          if (!p.running || !p.peers.length || await tmux.sessionUp(name)) continue;
          console.log(`${new Date().toISOString()} ${name} is down: bringing it back up`);
          for (const r of await up(name)) if (r.action !== "live") console.log(`  ${r.repo}: ${r.action}${r.detail ? ` (${r.detail})` : ""}`);
          await syncGroupNow(name).catch(() => {});
        } catch (e) {
          console.log(`${name}: auto-restart failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    if (once) return 0;
    await pause(15000);
  }
}

// Runs inside the pane. When claude exits (a double Ctrl-C, a crash, /exit) the
// pane stays: Enter relaunches on the same conversation, q closes it.
export function launch(name: string, repo: string): number {
  for (;;) {
    const rc = launchOnce(name, repo);
    for (;;) {
      console.log(`\nmy-claude: ${repo} exited ${rc}.  Enter: relaunch   s: shell here (host)   q: close pane   (closes by itself in 10 min)`);
      // 0 = Enter, 2 = s, anything else (q, timeout) closes.
      const key = spawnSync("bash", ["-c", 'read -rsn1 -t 600 k; case "$k" in "") exit 0;; s) exit 2;; *) exit 1;; esac'], { stdio: "inherit" }).status;
      if (key === 2) {
        // The profile failed (a broken dev.sh, a missing image): a plain host shell in the
        // checkout so the repo is never out of reach. Exit it to get this prompt back.
        const { path } = peerOf(load(name), repo);
        console.log(`my-claude: host shell in ${path}; exit to return\n`);
        spawnSync(hostShell().shell, hostShell().args, { stdio: "inherit", cwd: path, env: { ...process.env, MY_CLAUDE_PROJECT: name, MY_CLAUDE_PEER: repo } });
        continue;
      }
      if (key !== 0) return rc;
      console.log("");
      break;
    }
  }
}

function launchOnce(name: string, repo: string): number {
  const p = load(name);
  const peer = peerOf(p, repo);
  const prof = profile(p.profile);
  clearAttention(name, repo);
  // Trusted again right before claude starts: the mark made when the repo was added can be
  // lost, since every running Claude rewrites ~/.claude.json from its own copy.
  trustPath(peer.path);
  const args = claudeArgs(name, peer);
  const ctx = { project: name, repo, path: peer.path, session: peer.session, mode: p.mode, container: tmux.sess(name), args, cmdline: claudeLine(name, peer, args) };
  console.log(`my-claude: ${name}/${repo}  ${args[0] === "--resume" ? "resuming" : "new conversation"} ${peer.session.slice(0, 8)}  profile ${p.profile}${p.mode === "shared" ? " (shared container)" : ""}`);
  let rc: number;
  if (p.mode === "shared" && p.peers.indexOf(peer) !== 0) {
    let waited = 0;
    while (!prof.containerReady(ctx.container)) {
      if (waited === 0) console.log(`waiting for shared container ${ctx.container}...`);
      sleep(2000);
      waited += 2;
      if (waited >= 900) {
        console.error(`gave up after ${waited}s`);
        break;
      }
    }
    rc = waited >= 900 ? 1 : prof.exec(ctx);
  } else {
    rc = prof.launch(ctx);
  }
  return rc;
}
