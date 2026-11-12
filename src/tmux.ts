// One tmux session per project (mc-<name>), one window, one titled pane per peer.
import { readFileSync } from "node:fs";
import { ok, out, run } from "./sh.ts";
import { layout } from "./layout.ts";

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
  }
  out("tmux", ["select-pane", "-t", pane, "-T", repo]);
  tile(name);
  return pane;
}

export const PANEL_TITLE = "my-claude-panel";

// Re-layout the project window: panel column left (if open), everything else tiled.
export function tile(name: string): void {
  if (name.startsWith("mc-")) name = name.slice(3);
  const s = sess(name);
  if (!sessionUp(name)) return;
  const dims = out("tmux", ["display-message", "-p", "-t", `${s}:main`, "#{window_width} #{window_height}"], { ok: true }).split(" ").map(Number);
  if (dims.length !== 2 || !dims[0]) return;
  const all = panes(name);
  const panel = all.find((p) => p.title === PANEL_TITLE)?.id ?? null;
  const cells = all.filter((p) => p.title !== PANEL_TITLE).map((p) => p.id);
  const l = layout(dims[0], dims[1], panel, cells);
  if (l) out("tmux", ["select-layout", "-t", `${s}:main`, l], { ok: true });
}

// Hooks that keep the layout ours, server-wide: a pane dying or being killed, a client
// resizing or moving between sessions re-tiles that session (no-op outside mc-*).
export function installHooks(cli: string): void {
  for (const h of ["pane-exited", "after-kill-pane", "client-resized", "client-attached", "client-session-changed"])
    out("tmux", ["set-hook", "-g", h, `run-shell "${cli} _tile '#{session_name}'"`], { ok: true });
  // Where the client was when it detached (the session may differ from the one it
  // attached to): the menu reopens that project.
  out("tmux", ["set-hook", "-g", "client-detached", `run-shell "echo '#{session_name}' > '${LAST_SESSION_FILE}'"`], { ok: true });
}

export const LAST_SESSION_FILE = `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/my-claude-last-session`;

// Project the client detached from last, if it was a project session.
export function lastDetachedProject(): string | null {
  try {
    const s = readFileSync(LAST_SESSION_FILE, "utf8").trim();
    return s.startsWith("mc-") ? s.slice(3) : null;
  } catch {
    return null;
  }
}

export function panelPane(name: string): string | null {
  return panes(name).find((p) => p.title === PANEL_TITLE)?.id ?? null;
}

// Open the side panel in a project session (left column, unfocused unless asked).
export function openPanel(name: string, cli: string, focus: boolean): string {
  const s = sess(name);
  const have = panelPane(name);
  if (have) {
    if (focus) out("tmux", ["select-pane", "-t", have], { ok: true });
    return have;
  }
  const first = panes(name)[0]?.id ?? `${s}:main`;
  const id = out("tmux", ["split-window", "-d", "-hb", "-l", "30", "-P", "-F", "#{pane_id}", "-t", first, "-e", `MY_CLAUDE_PANEL_SESSION=${name}`, `${cli} _panel`]).trim();
  out("tmux", ["select-pane", "-t", id, "-T", PANEL_TITLE], { ok: true });
  tile(name);
  if (focus) out("tmux", ["select-pane", "-t", id], { ok: true });
  return id;
}

// The peer pane the user was on before focusing the panel (tmux's "last" pane), else the active one.
export function focusPanel(name: string): void {
  const id = panelPane(name);
  if (id) out("tmux", ["select-pane", "-t", id], { ok: true });
}

export function focusLast(): void {
  out("tmux", ["select-pane", "-l"], { ok: true });
}

export function focusedPeer(name: string): string | null {
  const lines = out("tmux", ["list-panes", "-t", `${sess(name)}:main`, "-F", "#{pane_active}\t#{pane_last}\t#{pane_title}"], { ok: true }).split("\n");
  const rows = lines.map((l) => l.split("\t"));
  const active = rows.find((r) => r[0] === "1");
  if (active && active[2] !== PANEL_TITLE) return active[2];
  return rows.find((r) => r[1] === "1" && r[2] !== PANEL_TITLE)?.[2] ?? null;
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
  // prefix+`: focus the side panel (opening it if closed).
  out("tmux", ["bind-key", "`", "run-shell", `${cli} panel`], { ok: true });
  installHooks(cli);
}

// Move the calling client to a project session, on a given peer's pane if asked.
export function switchTo(name: string, repo?: string): void {
  if (repo) {
    const pane = paneOf(name, repo);
    if (pane) out("tmux", ["select-pane", "-t", pane], { ok: true });
  }
  out("tmux", ["switch-client", "-t", sess(name)]);
}


export function currentSession(): string | null {
  return out("tmux", ["display-message", "-p", "#S"], { ok: true }) || null;
}

// Project and peer of the client's active pane (session name + pane title), or null outside a project.
export function activePeer(): { name: string; repo: string } | null {
  const line = out("tmux", ["display-message", "-p", "#S\t#{pane_title}"], { ok: true });
  const [s, repo] = line.split("\t");
  if (!s?.startsWith("mc-") || !repo) return null;
  return { name: s.slice(3), repo };
}

// A shell over the grid: a floating pane (tmux 3.8+), else a split below the active pane.
export function shellOverActive(cmd: string, title: string): void {
  if (floatingPanes()) {
    out("tmux", ["new-pane", "-T", title, "-x", "60%", "-y", "50%", "-X", "38%", "-Y", "45%", cmd]);
    return;
  }
  const id = out("tmux", ["split-window", "-v", "-l", "40%", "-P", "-F", "#{pane_id}", cmd]).trim();
  if (id) out("tmux", ["select-pane", "-t", id, "-T", title], { ok: true });
}

let floating: boolean | null = null;
function floatingPanes(): boolean {
  if (floating === null) floating = /^tmux (next-)?(\d+)\.(\d+)/.test(out("tmux", ["-V"], { ok: true })) && (() => {
    const m = out("tmux", ["-V"], { ok: true }).match(/(\d+)\.(\d+)/)!;
    return Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 8);
  })();
  return floating;
}

// Every pane of the project's window: peers carry their repo as title, shells "shell:<repo>".
// tmux 3.8's floating panes (prefix+*) are left out: they belong to no layout.
export function panes(name: string): { id: string; title: string }[] {
  const lines = out("tmux", ["list-panes", "-t", `${sess(name)}:main`, "-F", "#{pane_floating_flag}\t#{pane_id}\t#{pane_title}"], { ok: true });
  return lines.split("\n").filter(Boolean).map((l) => {
    const [fl, id, ...t] = l.split("\t");
    return fl === "1" ? null : { id, title: t.join("\t") };
  }).filter((x): x is { id: string; title: string } => x !== null);
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
