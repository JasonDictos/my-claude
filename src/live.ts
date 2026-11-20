// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Liveness. Ground truth is a Claude process whose cwd is the repo (compared by
// dev:inode so host and container paths agree); the lock file only decorates.
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Peer, Project } from "./store.ts";
import { paneInfo, panes, peerPane, sessionUp } from "./tmux.ts";
import { pause } from "./sh.ts";

// idle: the pane's shell is up but no claude runs in the repo (it exited; relaunch types it back in).
export type PeerState = "live" | "starting" | "idle" | "down" | "occupied";
const STARTING_GRACE_S = 180;
export type ProjectState = "UP" | "DOWN" | "PARTIAL";

const STUB = process.env.MY_CLAUDE_CLAUDE || "";
const EXE_RE = /\/\.local\/(share\/claude\/versions\/|bin\/claude$)/;

// Every Claude process on this directory (a session with subagents is several).
export function occupantPids(path: string): number[] {
  let want: { dev: number; ino: number };
  try {
    const st = statSync(path);
    want = { dev: Number(st.dev), ino: Number(st.ino) };
  } catch {
    return [];
  }
  const uid = process.getuid?.() ?? -1;
  const pids: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (statSync(`/proc/${d}`).uid !== uid) continue;
      const exe = readlinkSync(`/proc/${d}/exe`);
      const cmd = " " + readFileSync(`/proc/${d}/cmdline`, "utf8").replaceAll("\0", " ");
      // Tests and demos run a stand-in script (MY_CLAUDE_CLAUDE); it shows up by path on the command line.
      if (!EXE_RE.test(exe) && !(STUB && cmd.includes(STUB))) continue;
      const cwd = statSync(`/proc/${d}/cwd`);
      if (Number(cwd.dev) !== want.dev || Number(cwd.ino) !== want.ino) continue;
      if (cmd.includes(" daemon ") || cmd.includes(" bg-pty-host ")) continue;
      pids.push(Number(d));
    } catch {
      /* process went away mid-scan */
    }
  }
  return pids;
}

// The same answer as occupantPid() for many directories from ONE pass over /proc: the
// native app asks for every peer of every project each time it refreshes.
export function occupantsIndex(): (path: string) => number | null {
  const uid = process.getuid?.() ?? -1;
  const by = new Map<string, number[]>();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (statSync(`/proc/${d}`).uid !== uid) continue;
      const exe = readlinkSync(`/proc/${d}/exe`);
      const cmd = " " + readFileSync(`/proc/${d}/cmdline`, "utf8").replaceAll("\0", " ");
      if (!EXE_RE.test(exe) && !(STUB && cmd.includes(STUB))) continue;
      if (cmd.includes(" daemon ") || cmd.includes(" bg-pty-host ")) continue;
      const cwd = statSync(`/proc/${d}/cwd`);
      const key = `${Number(cwd.dev)}:${Number(cwd.ino)}`;
      by.set(key, [...(by.get(key) ?? []), Number(d)]);
    } catch {
      /* process went away mid-scan */
    }
  }
  return (path: string) => {
    try {
      const st = statSync(path);
      const pids = by.get(`${Number(st.dev)}:${Number(st.ino)}`) ?? [];
      return pids.find((p) => !pids.includes(ppid(p))) ?? pids[0] ?? null;
    } catch {
      return null;
    }
  };
}

// peerState() from facts already in hand (a pane's age in seconds, or null; the occupant pid).
export function peerStateOf(paneAge: number | null, pid: number | null): PeerState {
  if (paneAge !== null && pid) return "live";
  if (paneAge !== null) return paneAge < STARTING_GRACE_S ? "starting" : "idle";
  if (pid) return "occupied";
  return "down";
}

function ppid(pid: number): number {
  try {
    return Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1]);
  } catch {
    return 0;
  }
}

// The root of that set: the one whose parent is not itself an occupant.
export function occupantPid(path: string): number | null {
  const pids = occupantPids(path);
  return pids.find((p) => !pids.includes(ppid(p))) ?? pids[0] ?? null;
}

// The docker container a (host-visible, --pid=host) process runs in, from its cgroup; null on the host.
export function containerOf(pid: number): string | null {
  try {
    const m = readFileSync(`/proc/${pid}/cgroup`, "utf8").match(/docker-([0-9a-f]{64})\.scope/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function lockInfo(path: string): Record<string, unknown> | null {
  const f = join(path, ".claude", "session.lock");
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  } catch {
    return null;
  }
}

export async function peerState(p: Project, peer: Peer): Promise<PeerState> {
  const pane = await paneInfo(p.name, peer.repo);
  const pid = occupantPid(peer.path);
  if (pane && pid) return "live";
  if (pane) return pane.age < STARTING_GRACE_S ? "starting" : "idle";
  if (pid) return "occupied";
  return "down";
}

// One look at tmux and one at /proc for the whole project, however many peers it has.
export async function projectState(p: Project): Promise<ProjectState> {
  if (!(await sessionUp(p.name))) return "DOWN";
  const rows = await panes(p.name);
  const pidOf = occupantsIndex();
  const now = Math.floor(Date.now() / 1000);
  const live = (peer: Peer) => {
    const pane = peerPane(rows, peer.repo);
    return peerStateOf(pane ? Math.max(0, now - pane.start) : null, pidOf(peer.path)) === "live";
  };
  return p.peers.every(live) ? "UP" : "PARTIAL";
}

// TERM the whole set, KILL whatever is left after 5s. True when the repo is free afterwards.
export async function killOccupant(path: string): Promise<boolean> {
  const signal = (sig: NodeJS.Signals) => {
    for (const pid of occupantPids(path)) {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
  };
  if (occupantPids(path).length === 0) return true;
  signal("SIGTERM");
  for (let i = 0; i < 10 && occupantPids(path).length; i++) await pause(500);
  if (occupantPids(path).length) {
    signal("SIGKILL");
    await pause(1000);
  }
  return occupantPids(path).length === 0;
}
