// The commands. Pure functions over the record + tmux + liveness; the CLI and
// the menu both call these.
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { containerOf, killOccupant, lockInfo, occupantPid, peerState, projectState, type PeerState, type ProjectState } from "./live.ts";
import { profile } from "./profiles/index.ts";
import { out, shq, sleep } from "./sh.ts";
import * as peers from "./peers.ts";
import {
  NAME_RE, PROJECTS, ROOT, config, defaultProfile, die, exists, latestSession, listProjects, load, peerOf, remove, save, transcriptDir, transcriptPath, trustPath,
  type Mode, type Peer, type Project, type Role,
} from "./store.ts";
import * as tmux from "./tmux.ts";
import { PALETTE, projectColor } from "./colors.ts";

export interface PeerStatus extends Peer {
  state: PeerState;
  pane: string | null;
  pid: number | null;
  lock: Record<string, unknown> | null;
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
  last_used: number; // epoch seconds, 0 = never
}

const CLI = `${process.execPath} ${ROOT}/src/cli.ts`;

export function newProject(name: string, o: { goal?: string; shared?: boolean; profile?: string; color?: string } = {}): Project {
  if (!NAME_RE.test(name)) die(`bad project name '${name}'`);
  if (exists(name)) die(`project '${name}' exists`);
  const prof = o.profile ?? defaultProfile();
  profile(prof);
  if (o.color && !PALETTE[o.color]) die(`no color '${o.color}' (have: ${Object.keys(PALETTE).join(", ")})`);
  const p: Project = { name, goal: o.goal ?? "", mode: o.shared ? "shared" : "per-repo", profile: prof, lead: null, color: o.color ?? null, peers: [] };
  save(p);
  return p;
}

export function addPeer(name: string, path: string, o: { role?: Role; model?: string | null; repo?: string } = {}): Peer {
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
  trustPath(real);
  p.peers.push(peer);
  save(p);
  if (tmux.sessionUp(name)) spawn(p, peer);
  void syncGroup(p);
  return peer;
}

// Awaitable form for the CLI, which exits as soon as its command returns.
export async function syncGroupNow(name: string): Promise<void> {
  if (!exists(name)) return;
  await syncGroup(load(name));
}

// The claude-peers group named after the project holds every peer, addressed by path.
export function syncGroup(p: Project): Promise<unknown> {
  if (!peers.available()) return Promise.resolve();
  return p.peers.length ? peers.setGroup(p.name, p.peers.map((x) => x.path)) : peers.deleteGroup(p.name);
}

// What "Add repo" accepts, one line:
//   <existing path> [--name N]                  symlinked into projects/<name>/<repo>
//   <repo> | <org>/<repo> | <git url> [--branch B]   fresh clone into projects/<name>/<repo>
//   <github PR url>                              clone of the PR's head branch
export interface RepoSpec {
  kind: "path" | "clone";
  path?: string; // kind=path
  repo: string; // org/name for clone, basename for path
  branch?: string;
  display: string;
}

export function parseRepoSpec(line: string): RepoSpec & { name?: string } {
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
    const info = JSON.parse(out("gh", ["pr", "view", pr[2], "--repo", pr[1], "--json", "headRefName,headRepository,headRepositoryOwner"]));
    const repo = `${info.headRepositoryOwner?.login ?? pr[1].split("/")[0]}/${info.headRepository?.name ?? pr[1].split("/")[1]}`;
    return { kind: "clone", repo, branch: info.headRefName, display: `${repo}#${info.headRefName} (PR ${pr[2]})`, name };
  }
  const url = t.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (url) return { kind: "clone", repo: url[1], branch, display: url[1] + (branch ? `#${branch}` : ""), name };
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return { kind: "clone", repo: t, branch, display: t + (branch ? `#${branch}` : ""), name };
  if (/^[\w.-]+$/.test(t)) {
    const org = config().clone?.defaultOrg ?? die(`'${t}' is not a path; set clone.defaultOrg in config.json to clone <org>/${t}`);
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
  const spec = parseRepoSpec(line);
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
    const origin = out("git", ["-C", slot, "remote", "get-url", "origin"], { ok: true });
    if (!origin.includes(spec.repo)) die(`${slot} exists and is not a clone of ${spec.repo} (origin ${origin || "?"})`);
    if (spec.branch) {
      if (out("git", ["-C", slot, "status", "--porcelain"], { ok: true })) die(`${slot} has uncommitted changes; commit or stash before switching to ${spec.branch}`);
      o.log?.(`reusing clone, switching to ${spec.branch}...`);
      const proc = Bun.spawn(["bash", "-c", 'git fetch origin "$1" && git checkout "$1" && git pull --ff-only origin "$1"', "git", spec.branch], { cwd: slot, stdout: "pipe", stderr: "pipe" });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) die(`switch to ${spec.branch} failed: ${err.trim().split("\n").pop()}`);
    } else o.log?.(`reusing existing clone at ${slot}`);
    path = slot;
  } else {
    o.log?.(`cloning ${spec.display}...`);
    const args = ["repo", "clone", spec.repo, slot];
    if (spec.branch) args.push("--", "--branch", spec.branch);
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) die(`clone failed: ${err.trim().split("\n").pop()}`);
    path = slot;
  }
  return addPeer(name, path, { role: o.role, model: o.model, repo });
}

export function rmPeer(name: string, repo: string): string {
  const p = load(name);
  const peer = peerOf(p, repo);
  p.peers = p.peers.filter((x) => x.repo !== repo);
  if (p.lead === repo) p.lead = null;
  save(p);
  void syncGroup(p);
  refreshStatus(p);
  // Its pane (and the claude in it) goes too: the peer is no longer part of the project.
  if (tmux.sessionUp(name)) {
    const pane = tmux.paneOf(name, repo);
    if (pane) {
      killOccupant(peer.path);
      tmux.killPane(pane);
    }
    closeShellPanes(name, repo);
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
  return readdirSync(dir).filter((f) => {
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
  refreshStatus(p);
  return brief(p);
}

export async function brief(p: Project): Promise<string[]> {
  if (!p.lead) die(`${p.name} has no lead`);
  if (!peers.available()) return ["claude-peers CLI not found; briefs not sent"];
  const lead = peerOf(p, p.lead);
  const roster = p.peers.map((x) => `${x.repo} (${x.path})${x.repo === p.lead ? " [lead]" : ""}`).join(", ");
  const goal = p.goal ? p.goal : "(no goal written yet)";
  const notes: string[] = [];
  const leadMsg = `You lead project "${p.name}".\nGoal: ${goal}\nPeers: ${roster}.\nThey are the claude-peers group "${p.name}"; message it to reach everyone, or a peer by name. Coordinate the work across repos; you own the outcome.`;
  notes.push(`${lead.repo}: ${(await peers.send(lead.path, leadMsg)).out.split("\n")[0]}`);
  for (const x of p.peers) {
    if (x.repo === p.lead) continue;
    const msg = `You are part of project "${p.name}", working in ${x.repo} (${x.path}).\nLead: ${lead.repo} (${lead.path}); take direction from them.\nGoal: ${goal}\nThe claude-peers group "${p.name}" reaches everyone on the project.`;
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

export function deleteProject(name: string, force = false): string {
  load(name);
  const clones = clonesOf(name);
  if (clones.length && !force) die(`${name} has cloned repos (${clones.join(", ")}); use --force (they go to .trash, not rm -rf)`);
  tmux.killSession(name);
  const dest = remove(name);
  if (peers.available()) void peers.deleteGroup(name);
  return dest;
}

function spawn(p: Project, peer: Peer): string {
  const prof = profile(p.profile);
  const env = { MY_CLAUDE_ROOT: ROOT, MY_CLAUDE_PROJECT: p.name, MY_CLAUDE_PEER: peer.repo, ...prof.paneEnv(p.name, peer.repo) };
  const pane = tmux.spawnPane(p.name, peer.repo, peer.path, env, `${CLI} _launch ${p.name} ${peer.repo}`);
  refreshStatus(p);
  return pane;
}

export const cycle = tmux.cycle;

export function refreshStatus(p: Project): void {
  tmux.applyStatus(p.name, p.peers.map((x) => ({ repo: x.repo, lead: x.repo === p.lead })), projectColor(p.name, p.color).tmux, CLI);
}

export function setColor(name: string, color: string): void {
  if (!PALETTE[color]) die(`no color '${color}' (have: ${Object.keys(PALETTE).join(", ")})`);
  const p = load(name);
  p.color = color;
  save(p);
  refreshStatus(p);
}

export interface UpReport {
  repo: string;
  action: "live" | "starting" | "launched" | "relaunched" | "skipped" | "closed";
  detail?: string;
}

// Idempotent: launches only what is missing, never touches a live or stranger-held repo.
export function up(name: string): UpReport[] {
  if (existsSync("/.dockerenv")) die("up runs on the host, not in a container");
  const p = load(name);
  if (p.peers.length === 0) die(`${name} has no peers (my-claude add)`);
  profile(p.profile);
  const report: UpReport[] = [];
  for (const peer of p.peers) {
    const st = peerState(p, peer);
    if (st === "live" || st === "starting") report.push({ repo: peer.repo, action: st });
    else if (st === "idle") {
      relaunchInPane(p, peer, tmux.paneOf(name, peer.repo)!);
      report.push({ repo: peer.repo, action: "relaunched" });
    } else if (st === "occupied") {
      const lock = lockInfo(peer.path);
      report.push({ repo: peer.repo, action: "skipped", detail: `pid ${occupantPid(peer.path)} ${lock ? JSON.stringify(lock) : "(no lock)"}` });
    } else {
      spawn(p, peer);
      report.push({ repo: peer.repo, action: "launched" });
    }
  }
  if (!tmux.sessionUp(name)) die("nothing launched");
  // Panes for repos that are no longer peers (removed while the session was down, or
  // a record edited by hand): my-claude made them, my-claude closes them.
  for (const s of strayPanes(p)) {
    tmux.killPane(s.id);
    report.push({ repo: s.title, action: "closed", detail: "no longer a peer" });
  }
  void syncGroup(p);
  return report;
}

// Panes in the project window whose title is neither a peer nor a shell on one.
export function strayPanes(p: Project): { id: string; title: string }[] {
  if (!tmux.sessionUp(p.name)) return [];
  const known = new Set(p.peers.flatMap((x) => [x.repo, `shell:${x.repo}`]));
  return tmux.panes(p.name).filter((x) => !known.has(x.title));
}

function closeShellPanes(name: string, repo: string): void {
  for (const x of tmux.panes(name)) if (x.title === `shell:${repo}`) tmux.killPane(x.id);
}

export function down(name: string): boolean {
  load(name);
  if (!tmux.sessionUp(name)) return false;
  tmux.killSession(name);
  return true;
}

export function attach(name: string, repo?: string): number {
  const p = load(name);
  if (!tmux.sessionUp(name)) die(`project '${name}' is not up (my-claude up ${name})`);
  return tmux.attach(name, repo ?? p.lead ?? p.peers[0]?.repo);
}

export function restart(name: string, repo: string): void {
  const p = load(name);
  const peer = peerOf(p, repo);
  if (peerState(p, peer) === "occupied") die(`${repo} is occupied by a stranger; use takeover`);
  if (!killOccupant(peer.path)) die(`could not stop ${repo}`);
  const pane = tmux.paneOf(name, repo);
  if (pane) {
    sleep(1500); // let the shell take the prompt back before typing into it
    relaunchInPane(p, peer, pane);
  } else spawn(p, peer);
}

export function takeover(name: string, repo: string): void {
  const p = load(name);
  const peer = peerOf(p, repo);
  if (peerState(p, peer) !== "occupied") die(`${repo} is not occupied by a stranger`);
  if (!killOccupant(peer.path)) die(`could not stop the session on ${peer.path}`);
  spawn(p, peer);
}

export function status(name: string): ProjectStatus {
  const p = load(name);
  return {
    ...p,
    state: projectState(p),
    peers: p.peers.map((peer) => ({
      ...peer,
      state: peerState(p, peer),
      pane: tmux.paneOf(name, peer.repo),
      pid: occupantPid(peer.path),
      lock: lockInfo(peer.path),
    })),
    strays: strayPanes(p).map((x) => x.title),
  };
}

export function ls(): ProjectRow[] {
  return listProjects().map((p) => {
    let last = 0;
    for (const peer of p.peers) {
      try {
        last = Math.max(last, Math.floor(statSync(transcriptPath(peer.path, peer.session)).mtimeMs / 1000));
      } catch {
        /* no transcript yet */
      }
    }
    return { name: p.name, peers: p.peers.length, lead: p.lead, mode: p.mode, profile: p.profile, goal: p.goal, color: p.color ?? null, state: projectState(p), last_used: last };
  });
}

// `MY_CLAUDE_PROJECT=x MY_CLAUDE_PEER=y claude <args>` for a shell inside the peer's environment.
export function claudeLine(name: string, peer: Peer, args: string[]): string {
  return [`MY_CLAUDE_PROJECT=${shq(name)}`, `MY_CLAUDE_PEER=${shq(peer.repo)}`, "claude", ...args.map(shq)].join(" ");
}

function claudeArgs(name: string, peer: Peer): string[] {
  const args = [existsSync(transcriptPath(peer.path, peer.session)) ? "--resume" : "--session-id", peer.session];
  if (peer.model) args.push("--model", peer.model);
  args.push("--name", `${name}/${peer.repo}`);
  return args;
}

// The pane's shell is up but claude is gone: type it back in.
function relaunchInPane(p: Project, peer: Peer, pane: string): void {
  tmux.sendLine(pane, claudeLine(p.name, peer, claudeArgs(p.name, peer)));
}

// prefix+h from a project pane: open a shell in that peer's container, in a pane below.
export function shellHere(): void {
  const at = tmux.activePeer();
  if (!at) die("not in a my-claude project pane");
  const p = load(at.name);
  peerOf(p, at.repo);
  tmux.splitBelowActive(`${CLI} _shell ${at.name} ${at.repo}`, `shell:${at.repo}`);
}

// Runs in the new pane: find the peer's container by its claude's cgroup and exec a shell there.
export function shellPane(name: string, repo: string): number {
  const p = load(name);
  const peer = peerOf(p, repo);
  const pid = occupantPid(peer.path);
  const container = pid ? containerOf(pid) : null;
  console.log(`my-claude: shell in ${name}/${repo}${container ? ` (container ${container.slice(0, 12)})` : ""}  ${peer.path}`);
  return profile(p.profile).shellInto(container, peer.path);
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
        spawnSync(process.env.SHELL || "bash", [], { stdio: "inherit", cwd: path, env: { ...process.env, MY_CLAUDE_PROJECT: name, MY_CLAUDE_PEER: repo } });
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
