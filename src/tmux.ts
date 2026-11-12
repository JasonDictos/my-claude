// One tmux session per project (mc-<name>), one titled pane per peer, panes spread over
// windows ("tabs") once a window holds panesPerWindow of them (config, default 6); every
// window carries its own side-panel column.
import { readFileSync } from "node:fs";
import { ok, out, run } from "./sh.ts";
import { layout } from "./layout.ts";
import { config } from "./store.ts";

export const sess = (name: string) => `mc-${name}`;

export function sessionUp(name: string): boolean {
  return ok("tmux", ["has-session", "-t", sess(name)]);
}

// Pane id and age (seconds) of a peer's pane, or null.
export function paneInfo(name: string, repo: string): { id: string; age: number } | null {
  const p = panes(name).find((x) => x.title === repo);
  return p ? { id: p.id, age: Math.max(0, Math.floor(Date.now() / 1000) - p.start) } : null;
}

// Type a command line into a pane's shell.
export function sendLine(pane: string, line: string): void {
  out("tmux", ["send-keys", "-t", pane, "-l", line]);
  out("tmux", ["send-keys", "-t", pane, "Enter"]);
}

export function paneOf(name: string, repo: string): string | null {
  return panes(name).find((x) => x.title === repo)?.id ?? null;
}

export const perWindow = (): number => Math.max(1, Number(config().panesPerWindow) || 6);

export interface Win { id: string; index: number; active: boolean; width: number; height: number }
export function windows(name: string): Win[] {
  return out("tmux", ["list-windows", "-t", sess(name), "-F", "#{window_id}\t#{window_index}\t#{window_active}\t#{window_width}\t#{window_height}"], { ok: true })
    .split("\n").filter(Boolean).map((l) => { const [id, i, a, w, h] = l.split("\t"); return { id, index: Number(i), active: a === "1", width: Number(w), height: Number(h) }; })
    .sort((a, b) => a.index - b.index);
}

// Peer panes (not the panel) per window, in window order.
const cellsByWindow = (name: string) => {
  const m = new Map<string, string[]>();
  for (const w of windows(name)) m.set(w.id, []);
  for (const p of docked(name)) if (p.title !== PANEL_TITLE) m.get(p.window)?.push(p.id);
  return m;
};

export function spawnPane(name: string, repo: string, cwd: string, env: Record<string, string>, cmd: string): string {
  const s = sess(name);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  let pane: string;
  if (sessionUp(name)) {
    // The first window with room (shells count too: they take space); none -> a new tab.
    const cells = cellsByWindow(name);
    const target = windows(name).find((w) => (cells.get(w.id)?.length ?? 0) < perWindow());
    if (!target) {
      pane = out("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", s, "-n", String(windows(name).length + 1), "-c", cwd, ...envArgs, cmd]);
    } else {
      // Split the roomiest pane of that window; a small active pane gives "no space for a new pane".
      const biggest = out("tmux", ["list-panes", "-t", target.id, "-F", "#{pane_id} #{pane_width} #{pane_height}"], { ok: true })
        .split("\n").map((l) => l.split(" ")).sort((a, b) => Number(b[1]) * Number(b[2]) - Number(a[1]) * Number(a[2]))[0]?.[0] ?? target.id;
      const split = () => out("tmux", ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", biggest, "-c", cwd, ...envArgs, cmd]);
      try {
        pane = split();
      } catch {
        // Still no room: grow the window past any attached client, split, then let it follow the client again.
        out("tmux", ["set-option", "-t", s, "window-size", "manual"], { ok: true });
        out("tmux", ["resize-window", "-t", target.id, "-x", "400", "-y", "120"], { ok: true });
        try {
          pane = split();
        } finally {
          out("tmux", ["set-option", "-t", s, "window-size", "latest"], { ok: true });
        }
      }
    }
  } else {
    pane = out("tmux", ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", s, "-n", "1", "-x", "240", "-y", "70", "-c", cwd, ...envArgs, cmd]);
    out("tmux", ["set-option", "-t", s, "pane-border-status", "top"]);
    out("tmux", ["set-option", "-t", s, "pane-border-format", " #{pane_title} "]);
    out("tmux", ["set-option", "-t", s, "allow-set-title", "off"], { ok: true });
    out("tmux", ["set-option", "-t", s, "automatic-rename", "off"], { ok: true });
  }
  out("tmux", ["select-pane", "-t", pane, "-T", repo]);
  tile(name);
  return pane;
}

export const PANEL_TITLE = "my-claude-panel";

// Re-layout every window of the project: panel column left (if open), everything else
// tiled. A window left with nothing but its panel closes (the panel dies with it).
export function tile(name: string): void {
  if (name.startsWith("mc-")) name = name.slice(3);
  if (!sessionUp(name)) return;
  const all = docked(name);
  const wins = windows(name);
  for (const w of wins) {
    const mine = all.filter((p) => p.window === w.id);
    const panel = mine.find((p) => p.title === PANEL_TITLE)?.id ?? null;
    const cells = mine.filter((p) => p.title !== PANEL_TITLE).map((p) => p.id);
    if (!cells.length && panel && wins.length > 1) { out("tmux", ["kill-window", "-t", w.id], { ok: true }); continue; }
    if (!w.width) continue;
    const l = layout(w.width, w.height, panel, cells);
    if (l) out("tmux", ["select-layout", "-t", w.id, l], { ok: true });
  }
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

// The panel of the active window (the one the user sees), else any.
export function panelPane(name: string): string | null {
  const all = panes(name).filter((p) => p.title === PANEL_TITLE);
  return (all.find((p) => p.winActive) ?? all[0])?.id ?? null;
}

// Every window of the project gets its side panel; returns the active window's.
export function openPanel(name: string, cli: string, focus: boolean): string | null {
  const all = docked(name);
  let opened = false;
  for (const w of windows(name)) {
    const mine = all.filter((p) => p.window === w.id);
    if (mine.some((p) => p.title === PANEL_TITLE)) continue;
    const first = mine[0]?.id ?? w.id;
    const id = out("tmux", ["split-window", "-d", "-hb", "-l", "30", "-P", "-F", "#{pane_id}", "-t", first, "-e", `MY_CLAUDE_PANEL_SESSION=${name}`, `${cli} _panel`], { ok: true }).trim();
    if (id) { out("tmux", ["select-pane", "-t", id, "-T", PANEL_TITLE], { ok: true }); opened = true; }
  }
  if (opened) tile(name);
  const have = panelPane(name);
  if (focus && have) out("tmux", ["select-pane", "-t", have], { ok: true });
  return have;
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
  const rows = panes(name).filter((p) => p.winActive);
  const active = rows.find((r) => r.active);
  if (active && active.title !== PANEL_TITLE) return active.title;
  return rows.find((r) => r.last && r.title !== PANEL_TITLE)?.title ?? null;
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
  // prefix+n / prefix+p: next / previous tab of the project (tmux's own meaning).
  out("tmux", ["bind-key", "n", "next-window"], { ok: true });
  out("tmux", ["bind-key", "p", "previous-window"], { ok: true });
  // Mouse: a project on the status bar switches to it; a tab selects its window; a
  // minimised shell strip restores. Other clicks keep tmux's behaviour.
  out("tmux", ["bind-key", "-n", "MouseDown1StatusDefault", "run-shell", `${cli} _click '#{mouse_status_range}'`], { ok: true });
  out("tmux", ["bind-key", "-n", "MouseDown1Status", "select-window", "-t", "="], { ok: true });
  out("tmux", ["bind-key", "-n", "MouseDown1Pane", "if-shell", "-F", "-t", "=", `#{&&:#{pane_floating_flag},#{<=:#{pane_height},${MIN_H}}}`, `run-shell "${cli} _click 'pane:#{pane_id}'"`, "select-pane -t = ; send-keys -M"], { ok: true });
  installHooks(cli);
}

// Move the calling client to a project session, on a given peer's pane if asked.
export function switchTo(name: string, repo?: string): void {
  if (repo) {
    const pane = paneOf(name, repo);
    if (pane) { out("tmux", ["select-window", "-t", pane], { ok: true }); out("tmux", ["select-pane", "-t", pane], { ok: true }); }
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

// Minimised floating shells form a taskbar: two-line strips along the bottom edge, left to
// right, each as wide as its title, re-packed on every change. tmux has no hide, so the
// strip is the minimise; restoring brings the pane back to size, centred and in front.
export const MIN_H = 2;
const isMin = (p: PaneRow) => p.floating && p.height <= MIN_H;
export function minimiseFloat(name: string, id: string): void {
  const title = panes(name).find((p) => p.id === id)?.title ?? "";
  out("tmux", ["resize-pane", "-t", id, "-x", String(Math.max(12, title.length + 4)), "-y", String(MIN_H)], { ok: true });
  packMinimised(name);
}
export function restoreFloat(name: string, id: string): void {
  out("tmux", ["resize-pane", "-t", id, "-x", "60%", "-y", "50%"], { ok: true });
  out("tmux", ["move-pane", "-P", "centre", "-t", id], { ok: true });
  out("tmux", ["move-pane", "-z", "front", "-t", id], { ok: true });
  out("tmux", ["select-pane", "-t", id], { ok: true });
  packMinimised(name);
}
// Lay the minimised strips of each window along its bottom edge, in their current order.
export function packMinimised(name: string): void {
  const all = panes(name);
  for (const w of windows(name)) {
    let x = 0;
    for (const p of all.filter((q) => q.window === w.id && isMin(q)).sort((a, b) => a.start - b.start)) {
      out("tmux", ["move-pane", "-X", String(x), "-Y", String(Math.max(0, w.height - MIN_H - 2)), "-t", p.id], { ok: true });
      x += p.width + 2;
    }
  }
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

// Every pane of the project, all windows, floats included: peers carry their repo as
// title, shells "shell:<repo>", the panel its own.
export interface PaneRow { id: string; title: string; window: string; winActive: boolean; active: boolean; last: boolean; start: number; floating: boolean; width: number; height: number }
export function panes(name: string): PaneRow[] {
  const lines = out("tmux", ["list-panes", "-s", "-t", sess(name), "-F", "#{pane_floating_flag}\t#{pane_id}\t#{window_id}\t#{window_active}\t#{pane_active}\t#{pane_last}\t#{pane_start_time}\t#{pane_width}\t#{pane_height}\t#{pane_title}"], { ok: true });
  return lines.split("\n").filter(Boolean).map((l) => {
    const [fl, id, win, wa, pa, pl, st, w, h, ...t] = l.split("\t");
    return { id, title: t.join("\t"), window: win, winActive: wa === "1", active: pa === "1", last: pl === "1", start: Number(st || 0), floating: fl === "1", width: Number(w), height: Number(h) };
  });
}

// Layout members only: tmux 3.8's floating panes (prefix+*, our shells) belong to no layout.
export const docked = (name: string) => panes(name).filter((p) => !p.floating);

// The session's status bar, two rows, all clickable (tmux status ranges):
//   row 0: every project session, the current one on its color; click switches the client.
//   row 1: the project's windows as tabs named by their repos; click selects the window.
// Both are live format loops (#{S:} / #{W:}), nothing to refresh when things change.
export function applyStatus(name: string, peers: { repo: string; lead: boolean }[], color: string, cli: string): void {
  const s = sess(name);
  if (!sessionUp(name)) return;
  bindCycleKeys(cli);
  const set = (k: string, v: string) => out("tmux", ["set-option", "-t", s, k, v], { ok: true });
  set("@mc_color", color);
  const roster = peers.map((p) => (p.lead ? `#[bold]${p.repo}#[nobold]★` : p.repo)).join(" ");
  const cur = `#[range=user|proj:#{session_name}]#[bg=#{@mc_color}#,fg=colour232#,bold] #{s/^mc-//:session_name} #[default]#[norange]`;
  const other = `#[range=user|proj:#{session_name}]#[fg=#{@mc_color}] #{s/^mc-//:session_name} #[default]#[norange]`;
  const projects = `#{S:#{?#{m:mc-*,#{session_name}},#{?#{==:#{session_name},#{client_session}},${cur},${other}},}}`;
  const names = `#{P:#{?#{==:#{pane_title},${PANEL_TITLE}},,#{pane_title} }}`;
  set("status", "2");
  set("status-style", "bg=colour236,fg=colour250");
  set("status-format[0]", `#[align=left]${projects}#[align=right]#[fg=colour245]${roster} · prefix+h shell · prefix+n/p tab · prefix+d menu #[fg=${color}]█`);
  // Inline, not via window-status-*: those are per-window options and -t <session> sets one window.
  const tab = `#[range=window|#{window_index}]#[fg=colour245] #W #[fg=colour250]${names}#[norange]│`;
  const curTab = `#[range=window|#{window_index}]#[bg=${color}#,fg=colour232#,bold] #W ${names}#[default]#[norange]│`;
  set("status-format[1]", `#[align=left]#[list=on]#{W:${tab},${curTab}}#[nolist]`);
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
    if (pane) { out("tmux", ["select-window", "-t", pane], { ok: true }); out("tmux", ["select-pane", "-t", pane]); }
  }
  if (process.env.TMUX) return run("tmux", ["switch-client", "-t", sess(name)]);
  return run("tmux", ["attach", "-t", sess(name)]);
}
