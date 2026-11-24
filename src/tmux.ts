// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// One tmux session per project (mc-<name>), one titled pane per peer, in one of two layouts:
// grid (the terminal UI: tiled windows and the side panel) or solo (a window per pane, for the app).
import { existsSync, readFileSync } from "node:fs";
import { run, sh, shOk } from "./sh.ts";
import { layout } from "./layout.ts";
import { config, exists, load, type Layout } from "./store.ts";

// Between fields of a tmux format: tmux 3.6 prints a tab (and, outside a UTF-8 locale, any
// non-ASCII) as "_", so ASCII nobody types into a name.
export const SEP = "<|>";
export const sess = (name: string) => `mc-${name}`;

// A view session shares its project's windows, so the project of a pane, client or hook
// comes from the session group, never the session name alone.
export const PROJ = "#{?session_grouped,#{session_group},#{session_name}}";
export const VIEW_PREFIX = "mcv-";
export const viewName = (name: string, pane: string) => `${VIEW_PREFIX}${name.replace(/[^A-Za-z0-9_-]/g, "_")}-${pane.replace(/^%/, "")}`;

export async function sessionUp(name: string): Promise<boolean> {
  // "=" is exact. A bare name matches by prefix: mc-fe would answer for mc-febe.
  return await shOk("tmux", ["has-session", "-t", `=${sess(name)}`]);
}

// A peer's pane is the one titled with its repo that is not tagged as something else (a
// shell whose program retitled it).
export const peerPane = (rows: PaneRow[], repo: string): PaneRow | null => rows.find((x) => x.title === repo && !x.role) ?? null;

// Pane id and age (seconds) of a peer's pane, or null.
export async function paneInfo(name: string, repo: string): Promise<{ id: string; age: number } | null> {
  const p = peerPane(await panes(name), repo);
  return p ? { id: p.id, age: Math.max(0, Math.floor(Date.now() / 1000) - p.start) } : null;
}

// Type a command line into a pane's shell.
export async function sendLine(pane: string, line: string): Promise<void> {
  await sh("tmux", ["send-keys", "-t", pane, "-l", line]);
  await sh("tmux", ["send-keys", "-t", pane, "Enter"]);
}

// Text into a pane's program as a paste (several lines stay one message), then Enter.
export async function paste(pane: string, text: string): Promise<void> {
  await sh("tmux", ["set-buffer", "-b", "mc-review", "--", text]);
  await sh("tmux", ["paste-buffer", "-p", "-d", "-b", "mc-review", "-t", pane]);
  await sh("tmux", ["send-keys", "-t", pane, "Enter"]);
}

export async function paneOf(name: string, repo: string): Promise<string | null> {
  return peerPane(await panes(name), repo)?.id ?? null;
}

// tmux keeps scrollback in memory (about 800 bytes a line), so one chatty pane could take the
// server down: bounded (historyLimit). The window keeps its own, unlimited, on disk.
export const historyLimit = (): number => {
  const n = Number(config().historyLimit ?? 50000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
// How the native app shows a pane (see the top of this file).
// (A window on another machine can only be that: a view would be a program run there.)
export const nativePanes = (): boolean => !!process.env.MY_CLAUDE_REMOTE || config().gui?.panes !== "view";

export const layoutOf = (name: string): Layout => (exists(name) ? load(name).layout ?? "grid" : "grid");
// Panes per window: one in solo, panesPerWindow (config) in grid or when no project is named.
export const perWindow = (name?: string): number => (name && layoutOf(name) === "solo" ? 1 : Math.max(1, Number(config().panesPerWindow) || 6));

export interface Win { id: string; index: number; active: boolean; width: number; height: number }
export async function windows(name: string): Promise<Win[]> {
  return (await sh("tmux", ["list-windows", "-t", `=${sess(name)}`, "-F", ["#{window_id}", "#{window_index}", "#{window_active}", "#{window_width}", "#{window_height}"].join(SEP)], { ok: true }))
    .split("\n").filter(Boolean).map((l) => { const [id, i, a, w, h] = l.split(SEP); return { id, index: Number(i), active: a === "1", width: Number(w), height: Number(h) }; })
    .sort((a, b) => a.index - b.index);
}

// Peer panes (not the panel) per window, in window order.
const cellsByWindow = async (name: string) => {
  const m = new Map<string, string[]>();
  for (const w of await windows(name)) m.set(w.id, []);
  for (const p of await docked(name)) if (p.title !== PANEL_TITLE) m.get(p.window)?.push(p.id);
  return m;
};

export async function spawnPane(name: string, repo: string, cwd: string, env: Record<string, string>, cmd: string): Promise<string> {
  const s = sess(name);
  const solo = layoutOf(name) === "solo";
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  let pane: string;
  const limit = historyLimit();
  if (await sessionUp(name)) {
    // Sessions from before the bound existed: panes made from now on get it.
    if (limit) await sh("tmux", ["set-option", "-t", `=${s}:`, "history-limit", String(limit)], { ok: true });
    // The first window with room (shells count too: they take space); none -> a new tab.
    // In solo no window ever has room: one pane each.
    const cells = await cellsByWindow(name);
    const target = (await windows(name)).find((w) => (cells.get(w.id)?.length ?? 0) < perWindow(name));
    if (!target) {
      await sizeLikeNeighbours(name);
      // "<session>:" names the session; a bare name is tried as a window of whichever session is current first.
      pane = await sh("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${s}:`, "-n", String((await windows(name)).length + 1), "-c", cwd, ...envArgs, cmd]);
    } else {
      // Split the roomiest docked pane of that window; a small active pane gives "no space for
      // a new pane", and splitting a float would make the peer a float too.
      const biggest = (await sh("tmux", ["list-panes", "-t", target.id, "-F", "#{?pane_floating_flag,1,0} #{pane_id} #{pane_width} #{pane_height}"], { ok: true }))
        .split("\n").map((l) => l.split(" ")).filter((f) => f[0] === "0").sort((a, b) => Number(b[2]) * Number(b[3]) - Number(a[2]) * Number(a[3]))[0]?.[1] ?? target.id;
      const split = () => sh("tmux", ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", biggest, "-c", cwd, ...envArgs, cmd]);
      try {
        pane = await split();
      } catch {
        // Still no room: grow the window past any attached client, split, then let it follow the client again.
        await sh("tmux", ["set-option", "-t", s, "window-size", "manual"], { ok: true });
        await sh("tmux", ["resize-window", "-t", target.id, "-x", "400", "-y", "120"], { ok: true });
        try {
          pane = await split();
        } finally {
          await sh("tmux", ["set-option", "-t", s, "window-size", "latest"], { ok: true });
        }
      }
    }
  } else {
    await ensureServer();
    const create = ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", s, "-n", "1", "-x", "240", "-y", "70", "-c", cwd, ...envArgs, cmd];
    if (!limit) pane = await sh("tmux", create);
    else {
      // A session's first pane takes its history limit from the global option as it is
      // made, so the global one is lent our bound for that one command and put back.
      const before = await sh("tmux", ["start-server", ";", "show-options", "-gv", "history-limit"], { ok: true });
      try {
        pane = await sh("tmux", ["set-option", "-g", "history-limit", String(limit), ";", ...create]);
      } finally {
        if (before) await sh("tmux", ["set-option", "-g", "history-limit", before], { ok: true });
      }
      await sh("tmux", ["set-option", "-t", `=${s}:`, "history-limit", String(limit)], { ok: true });
    }
    await sh("tmux", ["set-option", "-t", s, "pane-border-status", "top"]);
    await sh("tmux", ["set-option", "-t", s, "pane-border-format", " #{pane_title} "]);
    await sh("tmux", ["set-option", "-t", s, "allow-set-title", "off"], { ok: true });
    await sh("tmux", ["set-option", "-t", s, "automatic-rename", "off"], { ok: true });
  }
  await sh("tmux", ["select-pane", "-t", pane, "-T", repo]);
  if (solo) await dressWindow(pane, "solo");
  await tile(name);
  return pane;
}

// systemd kills a stopping service's whole group, a tmux server it happened to start
// included: my-claude starts the server in a scope of its own.
export async function ensureServer(): Promise<void> {
  const ls = Bun.spawnSync(["tmux", "list-sessions"], { stdout: "ignore", stderr: "pipe" });
  if (ls.exitCode === 0 || !/no server|error connecting|No such file/i.test(ls.stderr.toString())) return;
  if (!Bun.which("systemd-run") || !process.env.XDG_RUNTIME_DIR || existsSync("/.dockerenv")) return;
  await sh("systemd-run", ["--user", "--scope", "--collect", "-q", `--unit=tmux-server-${process.pid}-${Date.now()}`, "--", "tmux", "start-server", ";", "set-option", "-g", "exit-empty", "off"], { ok: true });
}

// Per-window options (tmux has no per-session default). solo, natively: the app sizes the
// window itself, so it follows no client ("manual"); grid: client-sized, bordered, titled.
export async function dressWindow(target: string, to: Layout): Promise<void> {
  // one ordered command: separate calls racing each other could leave the size mode behind
  const set = (k: string, v: string) => ["set-option", "-w", "-t", target, k, v];
  const opts: [string, string][] = to === "solo"
    ? [["allow-set-title", "off"], ["automatic-rename", "off"], ...(nativePanes() ? [["aggressive-resize", "off"], ["window-size", "manual"]] as [string, string][] : [["aggressive-resize", "on"], ["window-size", "smallest"]] as [string, string][]), ["pane-border-status", "off"]]
    : [["allow-set-title", "off"], ["automatic-rename", "off"], ["aggressive-resize", "off"], ["window-size", "latest"], ["pane-border-status", "top"], ["pane-border-format", " #{pane_title} "]];
  await sh("tmux", opts.flatMap(([k, v], i) => [...(i ? [";"] : []), ...set(k, v)]), { ok: true });
}
// solo, natively: a new window starts at the size its neighbours have (the app sized each
// to its terminal) instead of tmux's 80x24, which spares the program in it one resize.
async function sizeLikeNeighbours(name: string): Promise<void> {
  if (layoutOf(name) !== "solo" || !nativePanes()) return;
  const size = await sh("tmux", ["display-message", "-p", "-t", `=${sess(name)}:`, "#{window_width}x#{window_height}"], { ok: true });
  if (/^\d+x\d+$/.test(size.trim())) await sh("tmux", ["set-option", "-t", `=${sess(name)}:`, "default-size", size.trim()], { ok: true });
}
export async function dressWindows(name: string, to: Layout): Promise<void> {
  await Promise.all((await windows(name)).map((w) => dressWindow(w.id, to)));
}

// Make the running session match a layout: solo, a window per pane, no panel; grid, panes
// joined back panesPerWindow to a window, peers first.
export async function relayout(name: string, to: Layout): Promise<void> {
  if (!await sessionUp(name)) return;
  const order = exists(name) ? load(name).peers.map((x) => x.repo) : [];
  const rank = (p: PaneRow) => { const i = p.role ? -1 : order.indexOf(p.title); return i < 0 ? order.length : i; };
  const cells = async () => (await panes(name)).filter((p) => p.title !== PANEL_TITLE).sort((a, b) => rank(a) - rank(b) || a.start - b.start || a.id.localeCompare(b.id));
  if (to === "solo") {
    for (const p of await panes(name)) if (p.title === PANEL_TITLE) await killPane(p.id);
    const kept = new Set<string>();
    let n = (await windows(name)).length;
    // Docked panes first, so a window keeps a real pane and never a float.
    for (const p of (await cells()).sort((a, b) => Number(a.floating) - Number(b.floating))) {
      if (!p.floating && !kept.has(p.window)) { kept.add(p.window); continue; }
      // "-t <session>:" says whose window it becomes: without it tmux puts the new window in
      // whichever session it thinks is current, which can be another project's.
      await sh("tmux", ["break-pane", "-d", "-s", p.id, "-t", `=${sess(name)}:`, "-n", String(++n)], { ok: true });
    }
  } else {
    await dressWindows(name, "grid"); // sizes follow the client again before panes are packed
    const all = await cells();
    const per = perWindow();
    const win = async (id: string) => (await panes(name)).find((p) => p.id === id)?.window ?? "";
    const homes = new Set<string>();
    for (let i = 0; i < all.length; i += per) {
      const chunk = all.slice(i, i + per);
      if (homes.has(await win(chunk[0].id))) await sh("tmux", ["break-pane", "-d", "-s", chunk[0].id, "-t", `=${sess(name)}:`], { ok: true });
      const home = await win(chunk[0].id);
      homes.add(home);
      for (const p of chunk.slice(1)) if ((await win(p.id)) !== home) await joinInto(p.id, chunk[0].id, home);
    }
  }
  await dressWindows(name, to);
  await tile(name);
}

// join-pane splits the target, which fails once it is too small: grow the window past any
// client for the join, as spawnPane does for a split.
async function joinInto(src: string, dst: string, home: string): Promise<void> {
  const join = () => sh("tmux", ["join-pane", "-d", "-s", src, "-t", dst]);
  try {
    await join();
  } catch {
    await sh("tmux", ["set-option", "-w", "-t", home, "window-size", "manual"], { ok: true });
    await sh("tmux", ["resize-window", "-t", home, "-x", "400", "-y", "120"], { ok: true });
    try { await join(); } catch { /* it keeps its own window; the rest still packs */ }
    await sh("tmux", ["set-option", "-w", "-t", home, "window-size", "latest"], { ok: true });
  }
  await sh("tmux", ["select-layout", "-t", home, "tiled"], { ok: true });
}

// What a non-peer pane is ("shell:<repo>", "host:<repo>", "chat:<project>"), kept in a pane
// option too: a program can rewrite its title and must not pass for the peer that way.
export async function tagPane(id: string, role: string): Promise<void> {
  await sh("tmux", ["select-pane", "-t", id, "-T", role], { ok: true });
  await sh("tmux", ["set-option", "-p", "-t", id, "@mc_role", role], { ok: true });
}

// solo layout: a shell, or the chat, is a window of its own.
export async function shellWindow(name: string, cmd: string, role: string): Promise<string> {
  await sizeLikeNeighbours(name);
  const id = (await sh("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${sess(name)}:`, "-n", String((await windows(name)).length + 1), cmd])).trim();
  await tagPane(id, role);
  await dressWindow(id, "solo");
  return id;
}

export const PANEL_TITLE = "my-claude-panel";

// Re-layout every window of the project: panel column left (if open), everything else
// tiled. A window left with nothing but its panel closes (the panel dies with it).
export async function tile(name: string): Promise<void> {
  if (name.startsWith("mc-")) name = name.slice(3);
  if (!await sessionUp(name)) return;
  const order = exists(name) ? load(name).peers.map((x) => x.repo) : [];
  const rank = (title: string) => { const i = order.indexOf(title); return i < 0 ? order.length : i; };
  const all = await docked(name);
  const wins = await windows(name);
  for (const w of wins) {
    const mine = all.filter((p) => p.window === w.id);
    const panel = mine.find((p) => p.title === PANEL_TITLE)?.id ?? null;
    // Cells in roster order, so a peer keeps its place across relaunches instead of
    // landing wherever its pane was created; panes that are no peer follow, in creation order.
    const cells = mine.filter((p) => p.title !== PANEL_TITLE).sort((a, b) => rank(a.title) - rank(b.title)).map((p) => p.id);
    if (!cells.length && panel && wins.length > 1) { await sh("tmux", ["kill-window", "-t", w.id], { ok: true }); continue; }
    if (!w.width) continue;
    // select-layout hands cells to panes by pane index and ignores the ids in the string,
    // so the panes themselves are put in the wanted order first (swap-pane keeps focus).
    const want = [...(panel ? [panel] : []), ...cells];
    const have = mine.map((p) => p.id);
    for (let i = 0; i < want.length; i++) {
      if (have[i] === want[i]) continue;
      const j = have.indexOf(want[i]);
      await sh("tmux", ["swap-pane", "-d", "-s", want[i], "-t", have[i]], { ok: true });
      [have[i], have[j]] = [have[j], have[i]];
    }
    const l = layout(w.width, w.height, panel, cells);
    if (l) await sh("tmux", ["select-layout", "-t", w.id, l], { ok: true });
  }
}

// Hooks that keep the layout ours, server-wide: a pane dying or being killed, a client
// resizing or moving between sessions re-tiles that session (no-op outside mc-*).
export async function installHooks(cli: string): Promise<void> {
  const jobs: Promise<string>[] = [];
  const hook = (name: string, command: string) => void jobs.push(sh("tmux", ["set-hook", "-g", name, command], { ok: true }));
  // skipped for the app's clients inside tmux: dragging its window would fork a process per
  // pane per step
  const own = "#{&&:#{m:mc-*,#{session_name}},#{!=:#{client_control_mode},1}}";
  for (const h of ["client-resized", "client-attached", "client-session-changed"])
    hook(h, `if-shell -F '${own}' "run-shell \\"${cli} _tile '#{session_name}'\\""`);
  // A pane belongs to every session of its group; the project is the group.
  for (const h of ["pane-exited", "after-kill-pane"])
    hook(h, `if-shell -F '#{m:mc-*,${PROJ}}' "run-shell \\"${cli} _tile '${PROJ}'\\""`);
  // Where the client was when it detached (the session may differ from the one it
  // attached to): the menu reopens that project.
  hook("client-detached", `if-shell -F '${own}' "run-shell \\"echo '#{session_name}' > '${LAST_SESSION_FILE}'\\""`);
  await Promise.all(jobs);
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
export async function panelPane(name: string): Promise<string | null> {
  const all = (await panes(name)).filter((p) => p.title === PANEL_TITLE);
  return (all.find((p) => p.winActive) ?? all[0])?.id ?? null;
}

// Every window of the project gets its side panel; returns the active window's.
export async function openPanel(name: string, cli: string, focus: boolean): Promise<string | null> {
  if (layoutOf(name) === "solo") return null; // the native app has its own project list
  const all = await docked(name);
  let opened = false;
  for (const w of await windows(name)) {
    const mine = all.filter((p) => p.window === w.id);
    if (mine.some((p) => p.title === PANEL_TITLE)) continue;
    const first = mine[0]?.id ?? w.id;
    const id = (await sh("tmux", ["split-window", "-d", "-hb", "-l", "30", "-P", "-F", "#{pane_id}", "-t", first, "-e", `MY_CLAUDE_PANEL_SESSION=${name}`, `${cli} _panel`], { ok: true })).trim();
    if (id) { await sh("tmux", ["select-pane", "-t", id, "-T", PANEL_TITLE], { ok: true }); opened = true; }
  }
  if (opened) await tile(name);
  const have = await panelPane(name);
  if (focus && have) await sh("tmux", ["select-pane", "-t", have], { ok: true });
  return have;
}

// The peer pane the user was on before focusing the panel (tmux's "last" pane), else the active one.
export async function focusPanel(name: string): Promise<void> {
  const id = await panelPane(name);
  if (id) await sh("tmux", ["select-pane", "-t", id], { ok: true });
}

export async function focusLast(): Promise<void> {
  await sh("tmux", ["select-pane", "-l"], { ok: true });
}

// Project sessions, in tmux's order.
export async function projectSessions(): Promise<string[]> {
  return (await sh("tmux", ["list-sessions", "-F", "#S"], { ok: true })).split("\n").filter((s) => s.startsWith("mc-"));
}

// Switch the calling client to the next/previous project session.
export async function cycle(dir: "next" | "prev"): Promise<string | null> {
  const all = await projectSessions();
  if (all.length === 0) return null;
  const cur = await sh("tmux", ["display-message", "-p", PROJ], { ok: true });
  const i = all.indexOf(cur);
  const target = i < 0 ? all[0] : all[(i + (dir === "next" ? 1 : all.length - 1)) % all.length];
  await sh("tmux", ["switch-client", "-t", target], { ok: true });
  return target;
}

// prefix+Tab / prefix+Shift+Tab cycle project sessions. Server-wide, set whenever a session is dressed.
async function bindCycleKeys(cli: string): Promise<void> {
  const jobs: Promise<string>[] = [];
  const bind = (...args: string[]) => void jobs.push(sh("tmux", ["bind-key", ...args], { ok: true }));
  bind("Tab", "run-shell", `${cli} next`);
  bind("BTab", "run-shell", `${cli} prev`);
  // prefix+h: another shell inside the highlighted peer's container; prefix+m minimises one.
  bind("h", "run-shell", `${cli} shell-here`);
  bind("H", "run-shell", `${cli} shell-here --host`);
  bind("m", "run-shell", `${cli} shell-min '#{pane_id}'`);
  // prefix+c: a floating chat with every peer of the project (you join the group as a peer).
  bind("c", "run-shell", `${cli} chat`);
  // prefix+x: close the pane the my-claude way (a peer pane removes the peer from the project).
  bind("x", "run-shell", `${cli} _close-ask '#{pane_id}' '#{client_name}'`);
  // Right click: our context menu instead of tmux's, on panes and on the status bar.
  bind("-n", "MouseDown3Pane", "run-shell", `${cli} _menu '#{pane_id}' '#{client_name}'`);
  for (const k of ["MouseDown3Status", "MouseDown3StatusDefault", "MouseDown3StatusLeft", "MouseDown3StatusRight"])
    bind("-n", k, "run-shell", `${cli} _menu '' '#{client_name}'`);
  // prefix+`: focus the side panel (opening it if closed).
  bind("`", "run-shell", `${cli} panel`);
  // prefix+n / prefix+p: next / previous tab of the project (tmux's own meaning).
  bind("n", "next-window");
  bind("p", "previous-window");
  // Mouse: a project on the status bar switches to it; a tab selects its window; a
  // minimised shell strip restores. Other clicks keep tmux's behaviour.
  bind("-n", "MouseDown1StatusDefault", "run-shell", `${cli} _click '#{mouse_status_range}' '#{client_name}'`);
  bind("-n", "MouseDown1Status", "select-window", "-t", "=");
  bind("-n", "MouseDown1Pane", "if-shell", "-F", "-t", "=", `#{&&:#{pane_floating_flag},#{<=:#{pane_height},${MIN_H}}}`, `run-shell "${cli} _click 'pane:#{pane_id}'"`, "select-pane -t = ; send-keys -M");
  await Promise.all(jobs);
  await installHooks(cli);
}

// Move the calling client to a project session, on a given peer's pane if asked.
export async function switchTo(name: string, repo?: string): Promise<void> {
  if (repo) await selectPeer(name, repo);
  await sh("tmux", ["switch-client", "-t", sess(name)]);
}

// A peer's pane to the front of the project's session, named: a bare pane target moves
// whichever session of the group is current, maybe one of the app's views.
async function selectPeer(name: string, repo: string): Promise<void> {
  const p = peerPane(await panes(name), repo);
  if (!p) return;
  await sh("tmux", ["select-window", "-t", `=${sess(name)}:${p.windowIndex}`], { ok: true });
  await sh("tmux", ["select-pane", "-t", p.id], { ok: true });
}

// The project session of the calling client (its group, when the client is a view).
export async function currentSession(): Promise<string | null> {
  return await sh("tmux", ["display-message", "-p", PROJ], { ok: true }) || null;
}

// When the calling client is one of the native app's views: its session and the app's socket.
export async function clientView(client = ""): Promise<{ session: string; sock: string } | null> {
  const [s, sock] = (await sh("tmux", ["display-message", "-p", ...(client ? ["-c", client] : []), `#{session_name}${SEP}#{@mc_host_sock}`], { ok: true })).split(SEP);
  return s?.startsWith(VIEW_PREFIX) ? { session: s, sock: sock ?? "" } : null;
}

// Project and peer of the client's active pane, or null outside a project. `repo` is the
// pane's tag when it has one ("shell:<repo>"), else its title (a peer's repo).
export async function activePeer(): Promise<{ name: string; repo: string; pane: string } | null> {
  const line = await sh("tmux", ["display-message", "-p", [PROJ, "#{pane_id}", "#{@mc_role}", "#{pane_title}"].join(SEP)], { ok: true });
  const [s, pane, role, ...rest] = line.split(SEP), title = rest.join(SEP);
  const repo = role || title;
  if (!s?.startsWith("mc-") || !repo) return null;
  return { name: s.slice(3), repo, pane };
}

// Minimised floats as a taskbar of two-line strips along the bottom (tmux cannot hide a
// pane); restoring brings one back to size, centred, in front.
export const MIN_H = 2;
const isMin = (p: PaneRow) => p.floating && p.height <= MIN_H;
export async function minimiseFloat(name: string, id: string): Promise<void> {
  const title = (await panes(name)).find((p) => p.id === id)?.title ?? "";
  await sh("tmux", ["resize-pane", "-t", id, "-x", String(Math.max(12, title.length + 4)), "-y", String(MIN_H)], { ok: true });
  await packMinimised(name);
}
export async function restoreFloat(name: string, id: string): Promise<void> {
  await sh("tmux", ["resize-pane", "-t", id, "-x", "60%", "-y", "50%"], { ok: true });
  await sh("tmux", ["move-pane", "-P", "centre", "-t", id], { ok: true });
  await sh("tmux", ["move-pane", "-z", "front", "-t", id], { ok: true });
  await sh("tmux", ["select-pane", "-t", id], { ok: true });
  await packMinimised(name);
}
// Lay the minimised strips of each window along its bottom edge, in their current order.
export async function packMinimised(name: string): Promise<void> {
  const all = await panes(name);
  for (const w of await windows(name)) {
    let x = 0;
    for (const p of all.filter((q) => q.window === w.id && isMin(q)).sort((a, b) => a.start - b.start)) {
      await sh("tmux", ["move-pane", "-X", String(x), "-Y", String(Math.max(0, w.height - MIN_H - 2)), "-t", p.id], { ok: true });
      x += p.width + 2;
    }
  }
}

// A shell over the grid: a floating pane (tmux 3.8+), else a split below the active pane.
export async function shellOverActive(cmd: string, title: string, nth = 0): Promise<void> {
  if (await floatingPanes()) {
    const off = Math.min(nth, 4) * 3; // percent; each further shell sits a step down and right
    const id = (await sh("tmux", ["new-pane", "-P", "-F", "#{pane_id}", "-T", title, "-x", "60%", "-y", "50%", "-X", `${38 + off}%`, "-Y", `${45 - off}%`, cmd])).trim();
    if (id) await sh("tmux", ["set-option", "-p", "-t", id, "@mc_role", title], { ok: true });
    return;
  }
  const id = (await sh("tmux", ["split-window", "-v", "-l", "40%", "-P", "-F", "#{pane_id}", cmd])).trim();
  if (id) await tagPane(id, title);
}

let floating: boolean | null = null;
async function floatingPanes(): Promise<boolean> {
  if (floating === null) {
    const m = (await sh("tmux", ["-V"], { ok: true })).match(/^tmux (?:next-)?(\d+)\.(\d+)/);
    floating = !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 8));
  }
  return floating;
}

// Every pane of the project, floats included: peers titled by repo, shells and the chat by
// their `role` tag.
export interface PaneRow { id: string; title: string; role: string; name: string; window: string; windowIndex: number; winActive: boolean; active: boolean; last: boolean; start: number; floating: boolean; width: number; height: number }
// The panes whose Claude is busy now. While it works Claude Code shows a spinner line above its
// input box ("* Unraveling… (1m 9s · …)") and usually ends its footer with "esc to interrupt"
// (a crowded footer drops that). Only the bottom of the screen counts: the same words may sit
// anywhere in what it wrote.
const SPINNER = /…\s*\((?:\d+h\s+)?(?:\d+m\s+)?\d+s\b/;
export async function busy(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const END = "\u001fmc-end ";
  const out = await sh("tmux", ids.flatMap((id, i) => [...(i ? [";"] : []), "capture-pane", "-p", "-t", id, ";", "display-message", "-p", "-t", id, `${END}#{pane_id}`]), { ok: true });
  const found = new Set<string>();
  let lines: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith(END)) {
      const shown = lines.filter((l) => l.trim());
      if (shown.slice(-3).some((l) => /esc to interrupt/i.test(l)) || shown.slice(-10).some((l) => SPINNER.test(l))) found.add(line.slice(END.length));
      lines = [];
    } else lines.push(line);
  }
  return found;
}

export async function panes(name: string): Promise<PaneRow[]> {
  const lines = await sh("tmux", ["list-panes", "-s", "-t", `=${sess(name)}`, "-F", ["#{pane_floating_flag}", "#{pane_id}", "#{window_id}", "#{window_index}", "#{window_active}", "#{pane_active}", "#{pane_last}", "#{pane_start_time}", "#{pane_width}", "#{pane_height}", "#{@mc_name}", "#{@mc_role}", "#{pane_title}"].join(SEP)], { ok: true });
  return lines.split("\n").filter(Boolean).map((l) => {
    const [fl, id, win, wi, wa, pa, pl, st, w, h, nm, role, ...t] = l.split(SEP);
    return { id, title: t.join(SEP), role: role ?? "", name: nm ?? "", window: win, windowIndex: Number(wi), winActive: wa === "1", active: pa === "1", last: pl === "1", start: Number(st || 0), floating: fl === "1", width: Number(w), height: Number(h) };
  });
}

// A pane's name in the window, given by the user (empty: back to the default).
export async function renamePane(pane: string, label: string): Promise<void> {
  label = label.split(SEP).join("");
  await sh("tmux", ["set-option", "-p", ...(label ? [] : ["-u"]), "-t", pane, "@mc_name", ...(label ? [label] : [])], { ok: true });
}

// What a pane is called: its tag when it has one, else its title.
export const label = (p: PaneRow): string => p.role || p.title;

// Layout members only: tmux 3.8's floating panes (prefix+*, our shells) belong to no layout.
export const docked = async (name: string): Promise<PaneRow[]> => (await panes(name)).filter((p) => !p.floating);

// Two clickable status rows, live tmux format loops: every project session, then this
// project's windows named by their repos.
export async function applyStatus(name: string, peers: { repo: string; lead: boolean }[], color: string, cli: string): Promise<void> {
  const s = sess(name);
  if (!await sessionUp(name)) return;
  await bindCycleKeys(cli);
  const jobs: Promise<string>[] = [];
  const set = (k: string, v: string) => void jobs.push(sh("tmux", ["set-option", "-t", s, k, v], { ok: true }));
  set("@mc_color", color);
  const roster = peers.map((p) => (p.lead ? `#[bold]${p.repo}#[nobold]★` : p.repo)).join(" ");
  const cur = `#[range=user|proj:#{session_name}]#[bg=#{@mc_color}#,fg=colour232#,bold] #{s/^mc-//:session_name} #[default]#[norange]`;
  const other = `#[range=user|proj:#{session_name}]#[fg=#{@mc_color}] #{s/^mc-//:session_name} #[default]#[norange]`;
  const projects = `#{S:#{?#{m:mc-*,#{session_name}},#{?#{==:#{session_name},#{client_session}},${cur},${other}},}}`;
  const names = `#{P:#{?#{==:#{pane_title},${PANEL_TITLE}},,#{pane_title} }}`;
  set("status", "2");
  set("status-style", "bg=colour236,fg=colour250");
  // The key hint follows what is focused: a float (shell or chat) says how to minimise or
  // leave it; otherwise the usual keys, plus how to get a minimised strip back when one exists.
  const minimised = `#{P:#{?#{&&:#{pane_floating_flag},#{<=:#{pane_height},${MIN_H}}},M,}}`;
  const floatHelp = `#{?#{m:chat:*,#{pane_title}},Ctrl-D leaves chat,exit closes shell} · prefix+m minimise · prefix+x close`;
  const gridHelp = `#{?${minimised},click a bottom strip to restore · ,}prefix+h shell · prefix+H host shell · prefix+c chat · prefix+n/p tab · prefix+d menu`;
  set("status-format[0]", `#[align=left]${projects}#[align=right]#[fg=colour245]${roster} · #{?#{pane_floating_flag},${floatHelp},${gridHelp}} #[fg=${color}]█`);
  // Inline, not via window-status-*: those are per-window options and -t <session> sets one window.
  const tab = `#[range=window|#{window_index}]#[fg=colour245] #W #[fg=colour250]${names}#[norange]│`;
  const curTab = `#[range=window|#{window_index}]#[bg=${color}#,fg=colour232#,bold] #W ${names}#[default]#[norange]│`;
  set("status-format[1]", `#[align=left]#[list=on]#{W:${tab},${curTab}}#[nolist]`);
  set("pane-border-style", "fg=colour238");
  set("pane-active-border-style", `fg=${color}`);
  await Promise.all(jobs);
}

export async function killPane(pane: string): Promise<void> {
  await sh("tmux", ["kill-pane", "-t", pane], { ok: true });
}

// The project's session and every view grouped with it: killing only the first would
// leave the windows (and the peers in them) alive under the views.
export async function killSession(name: string): Promise<void> {
  const s = sess(name);
  for (const line of (await sh("tmux", ["list-sessions", "-F", `#{session_name}${SEP}#{session_group}`], { ok: true })).split("\n")) {
    const [n, g] = line.split(SEP);
    if (g === s && n !== s) await sh("tmux", ["kill-session", "-t", `=${n}`], { ok: true });
  }
  await sh("tmux", ["kill-session", "-t", `=${s}`], { ok: true });
}

// Blocks until the user detaches (or switches, when already inside tmux).
export async function attach(name: string, repo?: string): Promise<number> {
  if (repo) await selectPeer(name, repo);
  if (process.env.TMUX) return run("tmux", ["switch-client", "-t", sess(name)]);
  return run("tmux", ["attach", "-t", sess(name)]);
}

// A view (gui.panes "view"): a session grouped with the project's, showing one pane's window;
// it ends when its window changes, so a view never shows another pane.
export async function view(name: string, pane: string, sock: string): Promise<number> {
  const args = await viewArgs(name, pane, sock);
  if (!args) return 1;
  // Started from inside tmux, the app would hand $TMUX down and tmux would refuse to nest.
  const { TMUX: _t, TMUX_PANE: _p, ...env } = process.env;
  return run("tmux", args, { env });
}

// The tmux command line of a view (see view()), for a terminal to run directly; null when
// the pane is gone. A leftover session of the same name is cleared first.
export async function viewArgs(name: string, pane: string, sock: string, rows?: PaneRow[]): Promise<string[] | null> {
  const p = (rows ?? await panes(name)).find((x) => x.id === pane);
  if (!p) return null;
  const v = viewName(name, pane);
  await sh("tmux", ["kill-session", "-t", `=${v}`], { ok: true });
  const set = (k: string, val: string) => ["set-option", k, val, ";"];
  return ["new-session", "-t", sess(name), "-s", v, ";", ...set("status", "off"), ...set("destroy-unattached", "on"), ...(sock ? set("@mc_host_sock", sock) : []),
    "select-window", "-t", `:${p.windowIndex}`, ";", "set-hook", "session-window-changed", "kill-session"];
}
