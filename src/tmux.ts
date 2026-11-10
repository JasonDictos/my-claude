// One tmux session per project (mc-<name>), one window, one titled pane per peer.
import { ok, out, run } from "./sh.ts";

export const sess = (name: string) => `mc-${name}`;

export function sessionUp(name: string): boolean {
  return ok("tmux", ["has-session", "-t", sess(name)]);
}

// Pane id and age (seconds) of a peer's pane, or null.
export function paneInfo(name: string, repo: string): { id: string; age: number } | null {
  const lines = out("tmux", ["list-panes", "-t", `${sess(name)}:main`, "-F", "#{pane_id}\t#{pane_start_time}\t#{pane_title}"], { ok: true });
  for (const l of lines.split("\n")) {
    const [id, start, ...t] = l.split("\t");
    if (t.join("\t") === repo) return { id, age: Math.max(0, Math.floor(Date.now() / 1000) - Number(start || 0)) };
  }
  return null;
}

// Type a command line into a pane's shell.
export function sendLine(pane: string, line: string): void {
  out("tmux", ["send-keys", "-t", pane, "-l", line]);
  out("tmux", ["send-keys", "-t", pane, "Enter"]);
}

export function paneOf(name: string, repo: string): string | null {
  const lines = out("tmux", ["list-panes", "-t", `${sess(name)}:main`, "-F", "#{pane_id} #{pane_title}"], { ok: true });
  for (const l of lines.split("\n")) {
    const [id, ...t] = l.split(" ");
    if (t.join(" ") === repo) return id;
  }
  return null;
}

export function spawnPane(name: string, repo: string, cwd: string, env: Record<string, string>, cmd: string): string {
  const s = sess(name);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  let pane: string;
  if (sessionUp(name)) {
    // Split the roomiest pane; a small active pane gives "no space for a new pane".
    const biggest = out("tmux", ["list-panes", "-t", `${s}:main`, "-F", "#{pane_id} #{pane_width} #{pane_height}"], { ok: true })
      .split("\n").map((l) => l.split(" ")).sort((a, b) => Number(b[1]) * Number(b[2]) - Number(a[1]) * Number(a[2]))[0]?.[0] ?? `${s}:main`;
    const split = () => out("tmux", ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", biggest, "-c", cwd, ...envArgs, cmd]);
    try {
      pane = split();
    } catch {
      // Still no room: grow the window past any attached client, split, then let it follow the client again.
      out("tmux", ["set-option", "-t", s, "window-size", "manual"], { ok: true });
      out("tmux", ["resize-window", "-t", `${s}:main`, "-x", "400", "-y", "120"], { ok: true });
      try {
        pane = split();
      } finally {
        out("tmux", ["set-option", "-t", s, "window-size", "latest"], { ok: true });
      }
    }
  } else {
    pane = out("tmux", ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", s, "-n", "main", "-x", "240", "-y", "70", "-c", cwd, ...envArgs, cmd]);
    out("tmux", ["set-option", "-t", s, "pane-border-status", "top"]);
    out("tmux", ["set-option", "-t", s, "pane-border-format", " #{pane_title} "]);
    out("tmux", ["set-option", "-t", s, "allow-set-title", "off"], { ok: true });
    // A pane that dies (failed launch, exited claude) leaves a hole; keep the grid tiled.
    out("tmux", ["set-hook", "-t", s, "pane-exited", `select-layout -t ${s}:main tiled`], { ok: true });
  }
  out("tmux", ["select-pane", "-t", pane, "-T", repo]);
  out("tmux", ["select-layout", "-t", `${s}:main`, "tiled"]);
  return pane;
}

// Project sessions, in tmux's order.
export function projectSessions(): string[] {
  return out("tmux", ["list-sessions", "-F", "#S"], { ok: true }).split("\n").filter((s) => s.startsWith("mc-"));
}

// Switch the calling client to the next/previous project session.
export function cycle(dir: "next" | "prev"): string | null {
  const all = projectSessions();
  if (all.length === 0) return null;
  const cur = out("tmux", ["display-message", "-p", "#S"], { ok: true });
  const i = all.indexOf(cur);
  const target = i < 0 ? all[0] : all[(i + (dir === "next" ? 1 : all.length - 1)) % all.length];
  out("tmux", ["switch-client", "-t", target], { ok: true });
  return target;
}

// prefix+Tab / prefix+Shift+Tab cycle project sessions. Server-wide, set whenever a session is dressed.
function bindCycleKeys(cli: string): void {
  out("tmux", ["bind-key", "Tab", "run-shell", `${cli} next`], { ok: true });
  out("tmux", ["bind-key", "BTab", "run-shell", `${cli} prev`], { ok: true });
  // prefix+h: a shell inside the highlighted peer's container, in a pane below it.
  out("tmux", ["bind-key", "h", "run-shell", `${cli} shell-here`], { ok: true });
  // prefix+`: the side panel (projects and peers, Enter switches).
  out("tmux", ["bind-key", "`", "run-shell", `${cli} panel`], { ok: true });
}

// Move the calling client to a project session, on a given peer's pane if asked.
export function switchTo(name: string, repo?: string): void {
  if (repo) {
    const pane = paneOf(name, repo);
    if (pane) out("tmux", ["select-pane", "-t", pane], { ok: true });
  }
  out("tmux", ["switch-client", "-t", sess(name)]);
}

// The side panel as a popup docked on the left edge of the client.
export function panelPopup(cli: string, width = 34): void {
  out("tmux", ["display-popup", "-E", "-B", "-x", "0", "-y", "0", "-w", String(width), "-h", "100%", "-e", `MY_CLAUDE_PANEL_W=${width}`, `${cli} _panel`]);
}

// Project and peer of the client's active pane (session name + pane title), or null outside a project.
export function activePeer(): { name: string; repo: string } | null {
  const line = out("tmux", ["display-message", "-p", "#S\t#{pane_title}"], { ok: true });
  const [s, repo] = line.split("\t");
  if (!s?.startsWith("mc-") || !repo) return null;
  return { name: s.slice(3), repo };
}

export function splitBelowActive(cmd: string, title: string): void {
  const id = out("tmux", ["split-window", "-v", "-l", "40%", "-P", "-F", "#{pane_id}", cmd]).trim();
  if (id) out("tmux", ["select-pane", "-t", id, "-T", title], { ok: true });
}

// Every pane of the project's window: peers carry their repo as title, shells "shell:<repo>".
export function panes(name: string): { id: string; title: string }[] {
  const lines = out("tmux", ["list-panes", "-t", `${sess(name)}:main`, "-F", "#{pane_id}\t#{pane_title}"], { ok: true });
  return lines.split("\n").filter(Boolean).map((l) => {
    const [id, ...t] = l.split("\t");
    return { id, title: t.join("\t") };
  });
}

// The session's status bar: project on its color, peers (lead marked), how to get back.
export function applyStatus(name: string, peers: { repo: string; lead: boolean }[], color: string, cli: string): void {
  const s = sess(name);
  if (!sessionUp(name)) return;
  bindCycleKeys(cli);
  const roster = peers.map((p) => (p.lead ? `#[bold]${p.repo}#[nobold]★` : p.repo)).join("  ");
  const set = (k: string, v: string) => out("tmux", ["set-option", "-t", s, k, v], { ok: true });
  set("status", "on");
  set("status-style", "bg=colour236,fg=colour250");
  set("status-left-length", "80");
  set("status-left", `#[bg=${color},fg=colour232,bold] ${name} #[bg=colour236,fg=${color}]#[default] ${roster} `);
  set("status-right-length", "60");
  set("status-right", `#[fg=colour245]prefix+h shell · prefix+Tab next · prefix+d menu #[fg=${color}]█`);
  set("window-status-format", "");
  set("window-status-current-format", "");
  set("pane-border-style", "fg=colour238");
  set("pane-active-border-style", `fg=${color}`);
}

export function killPane(pane: string): void {
  out("tmux", ["kill-pane", "-t", pane], { ok: true });
}

export function killSession(name: string): void {
  out("tmux", ["kill-session", "-t", sess(name)], { ok: true });
}

// Blocks until the user detaches (or switches, when already inside tmux).
export function attach(name: string, repo?: string): number {
  if (repo) {
    const pane = paneOf(name, repo);
    if (pane) out("tmux", ["select-pane", "-t", pane]);
  }
  if (process.env.TMUX) return run("tmux", ["switch-client", "-t", sess(name)]);
  return run("tmux", ["attach", "-t", sess(name)]);
}
