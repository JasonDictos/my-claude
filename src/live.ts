// Liveness. Ground truth is a Claude process whose cwd is the repo (compared by
// dev:inode so host and container paths agree); the lock file only decorates.
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Peer, Project } from "./store.ts";
import { paneInfo, sessionUp } from "./tmux.ts";
import { sleep } from "./sh.ts";

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

export function peerState(p: Project, peer: Peer): PeerState {
  const pane = paneInfo(p.name, peer.repo);
  const pid = occupantPid(peer.path);
  if (pane && pid) return "live";
  if (pane) return pane.age < STARTING_GRACE_S ? "starting" : "idle";
  if (pid) return "occupied";
  return "down";
}

export function projectState(p: Project): ProjectState {
  if (!sessionUp(p.name)) return "DOWN";
  return p.peers.every((peer) => peerState(p, peer) === "live") ? "UP" : "PARTIAL";
}

// TERM the whole set, KILL whatever is left after 5s. True when the repo is free afterwards.
export function killOccupant(path: string): boolean {
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
  for (let i = 0; i < 10 && occupantPids(path).length; i++) sleep(500);
  if (occupantPids(path).length) {
    signal("SIGKILL");
    sleep(1000);
  }
  return occupantPids(path).length === 0;
}
