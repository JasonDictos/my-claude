// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// The window's driver (`my-claude _gui`, started and restarted by mc-term): keeps the window
// true to the projects and does what it asks. It owns no session, so a crash here costs nothing.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import * as core from "./core.ts";
import * as tmux from "./tmux.ts";
import * as consoles from "./consoles.ts";
import { attention, attentionMark, clearAttention, type Attention } from "./attention.ts";
import { COLOR_CHOICES, PALETTE } from "./colors.ts";
import { defaultSocket, hostAlive, hostLink, hostSend, type HostLink } from "./host.ts";
import { profile, profiles } from "./profiles/index.ts";
import { REMOTE_PATH } from "./remote.ts";
import { lockInfo, occupantPid, whoOf } from "./live.ts";
import type { ProfileAction } from "./profiles/types.ts";
import { CONFIG_DIR, PROJECTS, ROOT, UsageError, config, daemonSettings, defaultProfile, load, saveConfig, slug, type Trashed } from "./store.ts";
import { adoptShellEnv, out, sh, shOk } from "./sh.ts";

type Dict = Record<string, any>;
type Repo = { name: string; description: string };
const isRepo = (path: string) => existsSync(join(path, ".git"));
// "2026-11-20 10:04": readable, and sorts as text
const stamp = (ms: number) => { const d = new Date(ms), z = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const POLL_MS = 1500;
const MODELS = ["default", "fable-5.1", "opus-5.5", "sonnet-5.5"];
const BUILD_HELP = `my-claude gui: the window is a small Qt program in ${ROOT}/host. It needs cmake, ninja, a C++ compiler,
  Qt 6 (widgets, network, svg, dbus) and qtermwidget:
    Fedora:          sudo dnf install cmake ninja-build gcc-c++ qt6-qtbase-devel qt6-qtsvg-devel qtermwidget-devel libxcb-devel
    Debian/Ubuntu:   sudo apt install cmake ninja-build g++ qt6-base-dev libqt6svg6-dev libqtermwidget6-2-dev libxcb1-dev
  then:   my-claude gui --build
  (A machine with no screen needs none of this: open its projects from one that has, with
   my-claude gui --remote user@host, or use the terminal UI: my-claude)`;
const NO_WINDOW = `my-claude gui: the window (mc-term) is not installed here. Install my-claude's package
  (.rpm or .deb from https://github.com/JasonDictos/my-claude/releases), or put the self-contained
  mc-term from there in ~/.local/bin and make it executable.`;
const log = (m: string) => console.error(`${new Date().toISOString()} ${m}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
const split2 = (s: string): [string, string] => { const i = s.indexOf("/"); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]; };

// ---- starting the window ---------------------------------------------------------------

// The menu starts us with the session's PATH, which can lack ~/.local/bin (where deploy puts the window).
function hostBinary(): string | null {
  const cands = [config().gui?.host as string | undefined, join(ROOT, "host", "build", "mc-term"), out("sh", ["-c", "command -v mc-term"], { ok: true }),
    join(homedir(), ".local", "bin", "mc-term"), "/usr/bin/mc-term"];
  return cands.map((c) => (c ?? "").replace(/^~/, homedir())).find((c) => c && existsSync(c)) ?? null;
}

// Started from the menu there is no terminal to read an error in: the desktop shows it too.
function complain(msg: string): void {
  console.error(msg);
  if (process.stderr.isTTY || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) return;
  const line = msg.replace(/^my-claude gui: /, "").replace(/\s+/g, " ").trim();
  const argv = Bun.which("notify-send") ? ["notify-send", "-a", "my-claude", "-i", "mc-term", "my-claude", line]
    : Bun.which("kdialog") ? ["kdialog", "--title", "my-claude", "--passivepopup", line, "20"] : null;
  if (argv) Bun.spawnSync(argv, { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
}

// A saved machine (the entry already there for that address, or a new one named after its host),
// connected to this machine's window from now on.
function keepConnected(dest: string, port: number | null): string {
  const g = config().gui ?? {}, hosts = (g.hosts ?? {}) as Record<string, { dest?: string; port?: number | null }>;
  let name = Object.keys(hosts).find((n) => hosts[n]?.dest === dest && (Number(hosts[n]?.port) || null) === port);
  if (!name) {
    const base = dest.replace(/^.*@/, "").replace(/^\[(.*)\]$/, "$1") || "remote";
    name = base;
    for (let i = 2; hosts[name]; i++) name = `${base}-${i}`;
  }
  const connected = ([] as string[]).concat(g.connected ?? []);
  saveConfig({ gui: { hosts: { [name]: { dest, port } }, connected: connected.includes(name) ? connected : [...connected, name] } });
  return name;
}

// gui.remote, from older versions, gave the window another machine's projects instead of this
// one's: that machine is now connected to this machine's window, which keeps its own.
function adoptOldRemote(): void {
  const g = config().gui ?? {}, dest = String(g.remote ?? "").trim();
  if (g.remote === undefined && g.remotePort === undefined) return;
  saveConfig({ gui: { remote: null, remotePort: null } });
  if (!dest) return;
  const name = keepConnected(dest, Number(g.remotePort) || null);
  console.error(`my-claude gui: ${dest} is now "${name}", a machine connected to this window (Connect › Manage machines… changes it)`);
}

function build(): number {
  const dir = join(ROOT, "host");
  if (!existsSync(join(dir, "CMakeLists.txt"))) { complain(NO_WINDOW); return 1; }
  try {
    for (const argv of [["cmake", "-S", dir, "-B", join(dir, "build"), "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release"], ["ninja", "-C", join(dir, "build")]]) {
      const r = Bun.spawnSync(argv, { stdio: ["ignore", "inherit", "inherit"] });
      if (r.exitCode !== 0) { complain(BUILD_HELP); return r.exitCode ?? 1; }
    }
  } catch (e) {
    complain(`my-claude gui: ${errText(e)}\n${BUILD_HELP}`);
    return 1;
  }
  return 0;
}

// "my-claude" in the desktop's application menu, with its icon; the window is built first if
// need be, so the first click opens it.
export function install(): number {
  if (!hostBinary()) {
    if (existsSync(join(ROOT, "host", "CMakeLists.txt"))) console.log("my-claude --install: building the window first (once)...");
    if (build() !== 0 || !hostBinary()) return 1;
  }
  // mc-term on PATH too, next to my-claude (the RPM puts it in /usr/bin itself; deploy puts the
  // window itself in ~/.local/bin, which a link would replace)
  const bin = hostBinary(), userBin = join(homedir(), ".local", "bin"), link = join(userBin, "mc-term");
  if (bin && !bin.startsWith("/usr/") && resolve(bin) !== link && !(existsSync(link) && realpathSync(link) === realpathSync(bin))) {
    mkdirSync(userBin, { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(bin, link);
  }
  const share = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const apps = join(share, "applications"), hicolor = join(share, "icons", "hicolor");
  mkdirSync(apps, { recursive: true });
  // The icon at every size the desktop asks for; a scalable one too when the repo has it.
  const src = join(ROOT, "host", "icons");
  for (const n of [16, 22, 24, 32, 48, 64, 128, 256, 512]) {
    const dir = join(hicolor, `${n}x${n}`, "apps");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(src, `mc-term-${n}.png`), join(dir, "mc-term.png"));
  }
  const scalable = join(hicolor, "scalable", "apps", "mc-term.svg");
  if (existsSync(join(src, "mc-term.svg"))) { mkdirSync(dirname(scalable), { recursive: true }); copyFileSync(join(src, "mc-term.svg"), scalable); }
  else rmSync(scalable, { force: true }); // an older placeholder would win over the pictures
  // by path: a menu that has not rescanned the icon theme yet (or a session reached over ssh,
  // which cannot tell it to) still finds it
  const iconFile = existsSync(join(hicolor, "scalable", "apps", "mc-term.svg")) ? join(hicolor, "scalable", "apps", "mc-term.svg") : join(hicolor, "256x256", "apps", "mc-term.png");
  // mc-term.desktop: the name the window gives itself (setDesktopFileName), so the taskbar
  // matches the running window to this entry and its icon.
  const entry = join(apps, "mc-term.desktop");
  writeFileSync(entry, [
    "[Desktop Entry]", "Type=Application", "Version=1.5", "Name=my-claude", "GenericName=Claude Code projects",
    "Comment=Claude Code projects: one tab per project, one terminal per repo",
    `Exec="${core.CLI}" gui`, `TryExec=${core.CLI}`, `Icon=${iconFile}`, "Terminal=false", "StartupNotify=true", "StartupWMClass=mc-term",
    "Categories=Development;", "Keywords=claude;ai;agents;tmux;terminal;projects;",
    "Actions=new-window;", "", "[Desktop Action new-window]", "Name=Raise the window", `Exec="${core.CLI}" gui`, "",
  ].join("\n"));
  // "my-claude <name>" for each saved machine (gui.hosts): this machine's window with that one connected
  for (const f of readdirSync(apps)) if (/^mc-term-host-.*\.desktop$/.test(f)) rmSync(join(apps, f), { force: true });
  for (const [name, h] of Object.entries((config().gui?.hosts ?? {}) as Record<string, { dest?: string; port?: number; key?: string; jump?: string }>)) {
    if (!h?.dest) continue;
    const tag = name.replace(/[^A-Za-z0-9_.-]/g, "_");
    writeFileSync(join(apps, `mc-term-host-${tag}.desktop`), [
      "[Desktop Entry]", "Type=Application", `Name=my-claude ${name}`, `Comment=my-claude, with the projects on ${h.dest}`,
      `Exec="${core.CLI}" gui --connect ${tag}`, `Icon=${iconFile}`, "Terminal=false",
      `StartupWMClass=mc-term`, "Categories=Development;", "",
    ].join("\n"));
  }
  // the drop-down key: an entry of its own (hidden from the menu) that KDE binds globally
  writeFileSync(join(apps, "mc-term-toggle.desktop"), [
    "[Desktop Entry]", "Type=Application", "Name=my-claude (show/hide)", "Comment=Show my-claude full screen, or hide it",
    `Exec="${core.CLI}" gui --toggle`, `Icon=${iconFile}`, "NoDisplay=true", "Terminal=false", "",
  ].join("\n"));
  const key = String(config().gui?.toggleKey ?? "Ctrl+Alt+T");
  if (Bun.which("kwriteconfig6") && key) {
    const kw = (group: string, k: string, v: string) => Bun.spawnSync(["kwriteconfig6", "--file", "kglobalshortcutsrc", "--group", "services", "--group", group, "--key", k, v]);
    // whatever else holds the key gives it up (KDE takes the first claim otherwise)
    const rc = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kglobalshortcutsrc");
    if (existsSync(rc)) {
      let group = "";
      for (const line of readFileSync(rc, "utf8").split("\n")) {
        const g = /^\[services\]\[(.+)\]$/.exec(line);
        if (g) { group = g[1]; continue; }
        if (line.startsWith("[")) { group = ""; continue; }
        const m = /^(\S+)=(.*)$/.exec(line);
        if (group && group !== "mc-term-toggle.desktop" && m && m[2].split("\t").includes(key)) { kw(group, m[1], "none"); console.log(`  ${key} taken from ${group}`); }
      }
    }
    kw("mc-term-toggle.desktop", "_launch", key);
    // KDE reads launcher shortcuts at login (registering one over D-Bus makes an inactive
    // component that swallows the key): from the next login, or System Settings → Shortcuts.
    console.log(`  ${key}: show/hide my-claude full screen, from the next login (gui.toggleKey in settings.json to change)`);
  }
  // let the desktop know now rather than at the next login
  for (const argv of [["update-desktop-database", apps], ["kbuildsycoca6", "--noincremental"], ["gtk-update-icon-cache", "-q", "-t", join(share, "icons", "hicolor")]])
    Bun.spawnSync(argv, { stdio: ["ignore", "ignore", "ignore"] });
  console.log(`installed: ${tilde(entry)} and its icon. "my-claude" is in the application menu under Development (and in the launcher search).`);
  return 0;
}

export function uninstall(): number {
  const share = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  for (const f of [join(share, "applications", "mc-term.desktop"), join(share, "icons", "hicolor", "scalable", "apps", "mc-term.svg"),
    ...[16, 22, 24, 32, 48, 64, 128, 256, 512].map((n) => join(share, "icons", "hicolor", `${n}x${n}`, "apps", "mc-term.png"))]) rmSync(f, { force: true });
  Bun.spawnSync(["kbuildsycoca6", "--noincremental"], { stdio: ["ignore", "ignore", "ignore"] });
  console.log("removed the menu entry and its icon");
  return 0;
}

export async function launch(args: string[]): Promise<number> {
  if (args.includes("--install")) return install();
  if (args.includes("--build")) return build();
  if (args.includes("--toggle")) {
    // a global key (Ctrl+Alt+T): show the window full screen in front, or hide it; start it first if need be
    const sock0 = defaultSocket();
    const started = !(await hostAlive(sock0));
    if (started) {
      const rc = await launch(args.filter((a) => a !== "--toggle"));
      if (rc !== 0) return rc;
    }
    // just started: always show (the new window may already count as active, which would hide it)
    await hostSend({ op: "toggle", show: started }, sock0);
    return 0;
  }
  if (args.includes("--connect")) {
    // a saved machine's launcher: this machine's window, that machine's projects added to it
    const want = args[args.indexOf("--connect") + 1] ?? "";
    const name = Object.keys(config().gui?.hosts ?? {}).find((n) => n === want || n.replace(/[^A-Za-z0-9_.-]/g, "_") === want);
    if (!name) { console.error(`my-claude gui --connect: no saved machine "${want}" (my-claude → Connect → Manage machines…)`); return 2; }
    const sock0 = defaultSocket();
    if (!(await hostAlive(sock0))) {
      const rc = await launch(["--local"]);
      if (rc !== 0) return rc;
    }
    // as if picked from the Connect menu; a driver still starting gets it when it is up
    await hostSend({ op: "emit", event: { ev: "action", action: `app.connect:${name}` } }, sock0);
    await hostSend({ op: "raise" }, sock0);
    return 0;
  }
  { const ui = args.indexOf("--unpin"); if (ui >= 0) { saveConfig({ gui: { hosts: { [args[ui + 1]]: null } } }); install(); console.log(`removed "my-claude ${args[ui + 1]}" from the menu`); return 0; } }
  adoptOldRemote();
  if (args.includes("--forget")) { console.log("my-claude gui: the window always opens this machine's projects; Connect › Disconnect drops another machine's"); return 0; }
  // Another machine's projects in a window of their own: all the window needs is ssh to it.
  const at = args.indexOf("--remote");
  if (at >= 0) {
    let dest = args[at + 1];
    if (!dest || dest.startsWith("-")) { console.error("usage: my-claude gui --remote user@host [--port N] [--save | --pin [--name N]]"); return 2; }
    const pi = args.indexOf("--port");
    let port = pi >= 0 ? args[pi + 1] : "";
    const hp = /^(.*?)\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(dest) ?? /^([^:]+):(\d+)$/.exec(dest);
    if (hp) { const two = hp.length === 4; dest = two ? hp[1] + hp[2] : hp[1]; port = port || (two ? hp[3] ?? "" : hp[2]); }
    if (args.includes("--pin") || args.includes("--install-shortcut")) {
      // a launcher of its own in the menu: "my-claude <name>"
      const ni = args.indexOf("--name");
      const name = ni >= 0 ? args[ni + 1] : dest.replace(/^.*@/, "");
      saveConfig({ gui: { hosts: { [name]: { dest, port: port ? Number(port) : null } } } });
      install();
      console.log(`my-claude gui: "my-claude ${name}" is in the menu (my-claude gui --unpin ${name} takes it out)`);
      return 0;
    }
    if (args.includes("--save")) {
      const name = keepConnected(dest, port ? Number(port) : null);
      console.log(`my-claude gui: ${name} (${dest}) is connected to this machine's window from now on`);
      return launch(["--connect", name]);
    }
    let bin = hostBinary();
    if (!bin && (build() !== 0 || !(bin = hostBinary()))) return 1;
    const { TMUX: _t, TMUX_PANE: _p, ...env } = process.env;
    const ki = args.indexOf("--identity"), ji = args.indexOf("--jump");
    const key = ki >= 0 ? args[ki + 1] : "", jumpHost = ji >= 0 ? args[ji + 1] : "";
    const argv = [bin, "--remote", dest, ...(port ? ["--port", port] : []), ...(key ? ["--identity", key.replace(/^~/, homedir())] : []), ...(jumpHost ? ["--jump", jumpHost] : []),
      "--remote-command", String(config().gui?.remoteCommand ?? "my-claude _gui")];
    if (args.includes("--fg")) return Bun.spawnSync(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1;
    Bun.spawn(["setsid", "-f", ...argv], { env, stdio: ["ignore", "ignore", "ignore"] });
    console.log(`my-claude gui: a window for ${dest} (ssh; its log is ~/.cache/my-claude/gui-driver.log)`);
    return 0;
  }
  const sock = defaultSocket();
  if (await hostAlive(sock)) {
    await hostSend({ op: "raise" }, sock);
    console.log("my-claude gui: already running; its window is raised");
    return 0;
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error(`my-claude gui: no screen here (no DISPLAY or WAYLAND_DISPLAY). From a machine with one:
  my-claude gui --remote ${process.env.USER ?? "you"}@${hostname()}${daemonSettings().ssh?.port ? ` --port ${daemonSettings().ssh.port}` : ""}
or the terminal UI here: my-claude`);
    return 1;
  }
  let bin = hostBinary();
  if (!bin) {
    if (existsSync(join(ROOT, "host", "CMakeLists.txt"))) console.error("my-claude gui: building the window first (once)...");
    if (build() !== 0 || !(bin = hostBinary())) return 1;
  }
  mkdirSync(dirname(sock), { recursive: true });
  // Started from inside tmux, the window would hand $TMUX to every terminal and tmux refuses to nest.
  const { TMUX: _t, TMUX_PANE: _p, ...env } = process.env;
  const argv = [bin, "--socket", sock, "--driver", `"${core.CLI}" _gui`];
  if (args.includes("--fg")) return Bun.spawnSync(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1;
  Bun.spawn(["setsid", "-f", ...argv], { env, stdio: ["ignore", "ignore", "ignore"] });
  for (let i = 0; i < 60; i++) {
    if (await hostAlive(sock)) { console.log("my-claude gui: started"); return 0; }
    await Bun.sleep(100);
  }
  complain("my-claude gui: the window did not come up; `my-claude gui --fg` in a terminal shows why");
  return 1;
}

// ---- the driver ------------------------------------------------------------------------


interface TermSpec { id: string; tab: string; title: string; color: string; attention: string; node: string; scheme?: string; textStep?: number; skey?: string }
interface Target { name: string | null; repo: string | null; pane: string | null }

const DOT_YELLOW = "#ffd75f", DOT_RED = "#ff5f5f";
const SHELL_COLOR = "#9aa0a6", CHAT_COLOR = "#d7af5f";
const attnBadge = (a: Attention) => attentionMark(a).trim();
// Icon sets: the window's own, and folders of the user's (to try a revision without a build).
const iconSets = (): string[] => {
  const mine = (() => { try { return readdirSync(join(CONFIG_DIR, "icons"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } })();
  return [...new Set(["v4", "v2", "classic", ...mine])];
};
// One spelling per key ("ctrl+shift+n", "Shift+Ctrl+N": the same), to compare keys by.
export const normKey = (k: string): string => {
  const s = k.trim().toLowerCase().replace(/\s+/g, "");
  const parts = s.endsWith("++") ? [...s.slice(0, -2).split("+"), "+"] : s.split("+");
  const key = parts.pop() ?? "";
  const alias: Record<string, string> = { control: "ctrl", super: "meta", win: "meta" };
  const order = ["ctrl", "alt", "shift", "meta"];
  return [...parts.map((m) => alias[m] ?? m).sort((a, b) => order.indexOf(a) - order.indexOf(b)), key].join("+");
};
const attnColor = (a: Attention) => (a === "ask" ? DOT_RED : DOT_YELLOW);

class Driver {
  private link!: HostLink;
  private snaps: core.ProjectSnap[] = [];
  private shown = new Set<string>(); // projects with a tab
  private hidden = new Set<string>(); // tabs the user closed: stay closed until asked for
  private wasUp = new Map<string, boolean>();
  private terms = new Map<string, TermSpec>(); // what the window was told to show
  private sent = new Map<string, string>(); // last value sent per thing, to send changes only
  private opens = new Map<string, number[]>();
  private relayoutAt = new Map<string, number>();
  private attn = new Map<string, Attention>();
  private pendingFocus: string | null = null;
  private pendingFocusAge = 0;
  private pendingTab: string | null = null;
  // projects being set up (undelete cloning their repos): greyed, their repos animated until done
  private settingUp = new Set<string>();
  private asks = new Map<string, (v: Dict | null) => void>();
  private askSeq = 0;
  private lists: ((l: Dict) => void)[] = [];
  private chains = new Map<string, Promise<void>>(); // work in order, per project
  private active = new Map<string, string[]>(); // project -> what is being done to it now
  private syncing = false;
  private syncAgain = false;
  private first = true;
  private adopted = false;

  constructor(private sock: string) {}

  async run(): Promise<number> {
    this.link = await hostLink(this.sock, (ev) => this.onEvent(ev));
    // behind everything else: who gh and ssh are signed in as, and the organisation's repos
    void this.ghWhoami().catch(() => {});
    void this.sshWhoami().catch(() => {});
    { const org = String(config().clone?.defaultOrg ?? ""); if (org) void this.orgRepos(org).catch(() => {}); }
    // the machines that were connected (a window that still has them keeps them as they are);
    // another machine's driver leaves that to the window's own
    for (const n of this.sock === "-" ? [] : ([] as string[]).concat(config().gui?.connected ?? [])) {
      const h = (config().gui?.hosts ?? {})[n] as { dest?: string; port?: number; key?: string; jump?: string } | undefined;
      if (h?.dest) this.connectMachine(n, h);
    }
    // terminals already shown: our predecessor died; take them as they are, then say who we
    // are (which hands us what the user did meanwhile)
    const have = await this.list();
    for (const t of (have.terminals ?? []) as Dict[]) {
      this.terms.set(t.id, { id: t.id, tab: t.tab, title: "", color: "", attention: "", node: "" });
      if (t.tab !== consoles.TAB) this.shown.add(t.tab);
    }
    this.adopted = this.terms.size > 0;
    log(`driver up on ${this.sock}${this.adopted ? `, taking over ${this.terms.size} terminals` : ""}`);
    this.send({ op: "busy", text: "" });
    await this.sync(); // know the projects before acting on anything held for us
    this.send({ op: "driver" });
    const timer = setInterval(() => this.requestSync(), POLL_MS);
    process.on("SIGTERM", () => { this.flushPrefs(); process.exit(0); });
    await this.link.closed;
    this.flushPrefs();
    clearInterval(timer);
    // the window vanished: here it died (projects back to the terminal UI's layout); from
    // another machine it is likelier the network, and it will be back (left as they are)
    if (!process.env.MY_CLAUDE_REMOTE) this.releaseAll();
    return 0;
  }

  // ---- plumbing

  private send(msg: Dict): void { this.link.send(msg); }
  private sendIfChanged(key: string, msg: Dict): void {
    const s = JSON.stringify(msg);
    if (this.sent.get(key) === s) return;
    this.sent.set(key, s);
    this.send(msg);
  }
  private notify(text: string, o: { error?: boolean; alert?: boolean } = {}): void {
    this.send({ op: "notify", text, level: o.error ? "error" : "info", alert: !!o.alert });
  }
  private list(): Promise<Dict> {
    return new Promise((resolve) => { this.lists.push(resolve); this.send({ op: "list" }); });
  }
  private ask(spec: Dict, id = `ask-${++this.askSeq}`): Promise<Dict | null> {
    return new Promise((resolve) => { this.asks.set(id, resolve); this.send({ op: "ask", id, ...spec }); });
  }
  private async confirm(title: string, text: string, ok: string): Promise<boolean> {
    return (await this.ask({ title, text, ok })) !== null;
  }
  private fail(e: unknown, what = ""): void {
    const text = `${what ? what + ": " : ""}${errText(e)}`;
    log(`error: ${text}${e instanceof Error && !(e instanceof UsageError) ? "\n" + e.stack : ""}`);
    this.notify(text, { error: true });
    void this.ask({ title: "my-claude", text, ok: "OK", cancel: "Close" });
  }
  // One project's changes in order, different projects in parallel (a clone in one never
  // holds up another); all awaited, so the window is answered meanwhile.
  private work(key: string, text: string, fn: () => void | Promise<void>): Promise<void> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(async () => {
      this.active.set(key, [text, ...(this.active.get(key) ?? [])]);
      this.showBusy();
      try {
        await fn();
      } catch (e) {
        this.fail(e);
      } finally {
        const left = (this.active.get(key) ?? []).slice(1);
        if (left.length) this.active.set(key, left);
        else this.active.delete(key);
        this.showBusy();
        this.requestSync();
      }
    });
    this.chains.set(key, run);
    return run;
  }
  // What the running work on `key` is doing right now (a clone's progress line).
  private progress(key: string, text: string): void {
    const a = this.active.get(key);
    if (!a?.length) return;
    a[0] = text;
    this.showBusy();
  }
  private showBusy(): void {
    this.sendIfChanged("busy", { op: "busy", text: [...this.active.values()].flat().filter(Boolean).join("  ·  ") });
  }
  // One look at a time; a request made during a look means another right after it.
  private requestSync(): void {
    if (this.syncing) { this.syncAgain = true; return; }
    void this.sync().catch((e) => log(`sync failed: ${e instanceof Error ? e.stack : e}`));
  }

  private snap(name: string | null): core.ProjectSnap | null {
    return (name && this.snaps.find((s) => s.project.name === name)) || null;
  }
  private byPane(name: string, pane: string): Target {
    const s = this.snap(name);
    const p = s?.panes.find((x) => x.id === pane);
    if (!s || !p) return { name, repo: null, pane: pane || null };
    const isPeer = !p.role && s.peers.some((x) => x.repo === p.title);
    return { name, repo: isPeer ? p.title : core.shellRepo(tmux.label(p)), pane };
  }
  // What an action is about: the tree entry it came from, else the pane the keyboard is in,
  // else the project of the tab in front.
  private target(ev: Dict): Target {
    const byNode = (node: string): Target | null => {
      if (node.startsWith("p:")) return { name: node.slice(2), repo: null, pane: null };
      if (node.startsWith("r:")) {
        const [name, repo] = split2(node.slice(2));
        return { name, repo, pane: this.snap(name)?.peers.find((x) => x.repo === repo)?.pane ?? null };
      }
      if (node.startsWith("t:")) { const [name, pane] = split2(node.slice(2)); return this.byPane(name, pane); }
      return null;
    };
    const node = String(ev.node ?? ""), id = String(ev.id ?? "").startsWith(`${consoles.TAB}/`) ? "" : String(ev.id ?? "");
    if (node && ev.focus !== "term") { const t = byNode(node); if (t) return t; }
    if (id) { const [name, pane] = split2(id); return this.byPane(name, pane); }
    if (node) { const t = byNode(node); if (t) return t; }
    return { name: ev.tab ? String(ev.tab) : null, repo: null, pane: null };
  }

  // ---- keeping the window true

  private async sync(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return; }
    this.syncing = true;
    try {
      await this.look();
    } finally {
      this.syncing = false;
      if (this.syncAgain) { this.syncAgain = false; this.requestSync(); }
    }
  }

  private async look(): Promise<void> {
    const [snaps, cons] = await Promise.all([core.snapshot(), consoles.list()]);
    this.snaps = snaps;
    const names = new Set(snaps.map((s) => s.project.name));
    for (const set of [this.shown, this.hidden]) for (const n of [...set]) if (!names.has(n)) set.delete(n);
    const openAtStart = config().gui?.openOnStart !== false;
    for (const s of snaps) {
      const n = s.project.name;
      // A project that comes up while we watch gets a tab (someone ran `up`, an agent started
      // one). At start every running project does, unless this window already had its tabs.
      const cameUp = s.up && this.wasUp.get(n) !== true;
      if (cameUp && !this.hidden.has(n) && (this.first ? !this.adopted && openAtStart : true)) this.shown.add(n);
      if (!s.up) this.shown.delete(n);
      this.wasUp.set(n, s.up);
    }
    this.first = false;

    // A project that is being changed right now (starting, a peer being removed) is left
    // to that change; it is looked at again the moment the change is done.
    await Promise.all(snaps.filter((s) => !this.active.has(s.project.name)).map((s) => (this.shown.has(s.project.name) ? this.ensure(s) : this.release(s))));
    for (const [id, t] of [...this.terms]) {
      if (this.shown.has(t.tab) || t.tab === consoles.TAB) continue;
      this.send({ op: "close", id });
      this.terms.delete(id);
      this.sent.delete(`term:${id}`);
    }
    const tabs = snaps.map((s) => s.project.name).filter((n) => this.shown.has(n));
    this.sendIfChanged("tabs", { op: "tabs", order: tabs });
    for (const key of [...this.sent.keys()]) if (key.startsWith("order:") && !this.shown.has(key.slice(6))) this.sent.delete(key);

    await this.ensureConsoles(cons);
    this.sendIfChanged("tree", { op: "tree", nodes: [this.consoleNode(cons), ...snaps.map((s) => this.projectNode(s))] });
    this.sendIfChanged("menu", { op: "menu", menus: this.menus() });
    // the dense bar over the list: icons by name (host/icons/tb-<icon>.svg when there is one)
    const sep = { separator: true };
    this.sendIfChanged("toolbar", { op: "toolbar", items: [
      { id: "app.new", label: "New project", icon: "new-project" }, { id: "project.add", label: "Add repos to the project", icon: "add-repos", scoped: true }, sep,
      { id: "project.open", label: "Start the project", icon: "start", scoped: true }, { id: "project.down", label: "Bring the project down", icon: "stop", scoped: true }, sep,
      { id: "pane.shell", label: "Shell in its environment (container)", icon: "shell", scoped: true }, { id: "pane.hostshell", label: "Host shell in its checkout", icon: "host-shell", scoped: true },
      { id: "pane.chat", label: "Chat with the peers", icon: "chat", scoped: true }, sep,
      { id: "app.quickconnect", label: "Connect a machine", icon: "connect" }, { id: "app.undelete", label: "Undelete a project", icon: "undelete" },
      { id: "host.settings", label: "Settings", icon: "settings" }] });
    this.sendIfChanged("settings", { op: "settings", ...this.settingsSpec() });
    this.sendIfChanged("placeholder", { op: "placeholder", text: snaps.length ? "No project open.\n\nPick one in the Projects list (Enter or a double-click starts it),\nor my-claude → New project." : "No projects yet.\n\nmy-claude → New project  (or press n in the Projects list)" });
    this.alerts(snaps);

    if (this.pendingTab && this.shown.has(this.pendingTab)) {
      this.send({ op: "tab", tab: this.pendingTab, focus: true });
      this.pendingTab = null;
    }
    if (this.pendingFocus) {
      if (this.terms.has(this.pendingFocus)) { this.send({ op: "focus", id: this.pendingFocus }); this.pendingFocus = null; }
      else if (++this.pendingFocusAge > 6) this.pendingFocus = null;
    }
  }

  // One project's tab: the solo layout underneath, then one terminal per tmux window.
  private async ensure(s: core.ProjectSnap): Promise<void> {
    const name = s.project.name;
    let rows = s.panes;
    const conforms = () => s.project.layout === "solo" && !rows.some((p) => p.title === tmux.PANEL_TITLE || p.floating) && new Set(rows.map((p) => p.window)).size === rows.length;
    if (!conforms() && Date.now() - (this.relayoutAt.get(name) ?? 0) > 10_000) {
      this.relayoutAt.set(name, Date.now());
      log(`${name}: switching to the solo layout`);
      await core.setLayout(name, "solo");
      s.project.layout = "solo";
      rows = s.panes = await tmux.panes(name);
    }
    const roster = s.project.peers.map((x) => x.repo);
    const cells = rows.filter((p) => p.title !== tmux.PANEL_TITLE).map((p) => {
      const lbl = tmux.label(p);
      const peer = p.role ? undefined : s.peers.find((x) => x.repo === p.title);
      const rank = peer ? roster.indexOf(peer.repo) : roster.length;
      const spec: TermSpec = peer
        ? { id: `${name}/${p.id}`, tab: name, title: peer.repo + (peer.repo === s.project.lead ? " ★" : ""), color: s.color, attention: attnBadge(peer.attn), node: `r:${name}/${peer.repo}` }
        : { id: `${name}/${p.id}`, tab: name, title: lbl, color: lbl.startsWith("chat:") ? CHAT_COLOR : SHELL_COLOR, attention: "", node: `t:${name}/${p.id}` };
      // its own colour scheme, kept under what the pane is: the peer, or the shell/chat's label
      spec.skey = peer ? `${name}/${peer.repo}` : `${name}/${lbl}`;
      spec.scheme = String(this.prefs("paneSchemes")[spec.skey] ?? "");
      spec.textStep = Number(this.prefs("paneText")[spec.skey] ?? 0);
      return { p, peer, rank, spec };
    }).sort((a, b) => a.rank - b.rank || a.p.start - b.p.start || a.p.id.localeCompare(b.p.id));

    const want = new Set(cells.map((c) => c.spec.id));
    for (const [id, t] of [...this.terms]) {
      if (t.tab !== name || want.has(id)) continue;
      this.send({ op: "close", id });
      this.terms.delete(id);
      this.sent.delete(`term:${id}`);
    }
    for (const { p, peer, spec } of cells) {
      if (!this.terms.has(spec.id)) {
        // A view that keeps dying (tmux refusing it) is not reopened in a loop.
        const now = Date.now();
        const tries = (this.opens.get(spec.id) ?? []).filter((t) => now - t < 20_000);
        if (tries.length >= 4) continue;
        // Natively (the window is the pane's terminal, through a tmux control client), or
        // as a view (a tmux client of its own draws the pane): config gui.panes.
        const how: Dict = tmux.nativePanes() ? { tmux: { session: tmux.sess(name), pane: p.id, window: p.window } } : {};
        if (!tmux.nativePanes()) {
          const args = await tmux.viewArgs(name, p.id, this.sock, rows);
          if (!args) continue;
          how.argv = ["tmux", ...args];
          how.cwd = peer?.path ?? join(PROJECTS, name);
        }
        this.opens.set(spec.id, [...tries, now]);
        this.sent.delete(`order:${name}`); // the window appends what it opens: say the order again
        this.terms.set(spec.id, spec);
        this.sent.set(`term:${spec.id}`, JSON.stringify(spec));
        this.send({ op: "open", ...spec, ...how, focus: this.pendingFocus === spec.id });
        if (this.pendingFocus === spec.id) this.pendingFocus = null;
      } else if (this.sent.get(`term:${spec.id}`) !== JSON.stringify(spec)) {
        this.terms.set(spec.id, spec);
        this.sent.set(`term:${spec.id}`, JSON.stringify(spec));
        this.send({ op: "set", ...spec });
      }
    }
    this.sendIfChanged(`order:${name}`, { op: "order", tab: name, ids: cells.map((c) => c.spec.id).filter((id) => this.terms.has(id)) });
    this.sendIfChanged(`tabcolor:${name}`, { op: "tab", tab: name, color: s.color });
  }

  // The consoles: always open in the window (it shows them or not), whatever tab is in front.
  private async ensureConsoles(cons: consoles.Console[]): Promise<void> {
    const specOf = (c: consoles.Console): TermSpec => {
      const spec: TermSpec = { id: `${consoles.TAB}/${c.pane}`, tab: consoles.TAB, title: c.name, color: SHELL_COLOR, attention: "", node: consoles.nodeOf(c.pane), skey: `${consoles.TAB}/${c.name}` };
      spec.scheme = String(this.prefs("paneSchemes")[spec.skey!] ?? "");
      spec.textStep = Number(this.prefs("paneText")[spec.skey!] ?? 0);
      return spec;
    };
    const want = new Set(cons.map((c) => specOf(c).id));
    for (const [id, t] of [...this.terms]) {
      if (t.tab !== consoles.TAB || want.has(id)) continue;
      this.send({ op: "close", id });
      this.terms.delete(id);
      this.sent.delete(`term:${id}`);
    }
    for (const c of cons) {
      const spec = specOf(c);
      if (!this.terms.has(spec.id)) {
        const now = Date.now();
        const tries = (this.opens.get(spec.id) ?? []).filter((t) => now - t < 20_000);
        if (tries.length >= 4) continue;
        const how: Dict = tmux.nativePanes()
          ? { tmux: { session: consoles.SESSION, pane: c.pane, window: c.window } }
          : { argv: ["tmux", ...await consoles.viewArgs(c, this.sock)], cwd: homedir() };
        this.opens.set(spec.id, [...tries, now]);
        this.sent.delete(`order:${consoles.TAB}`);
        this.terms.set(spec.id, spec);
        this.sent.set(`term:${spec.id}`, JSON.stringify(spec));
        this.send({ op: "open", ...spec, ...how, focus: this.pendingFocus === spec.id });
        if (this.pendingFocus === spec.id) this.pendingFocus = null;
      } else if (this.sent.get(`term:${spec.id}`) !== JSON.stringify(spec)) {
        this.terms.set(spec.id, spec);
        this.sent.set(`term:${spec.id}`, JSON.stringify(spec));
        this.send({ op: "set", ...spec });
      }
    }
    this.sendIfChanged(`order:${consoles.TAB}`, { op: "order", tab: consoles.TAB, ids: cons.map((c) => specOf(c).id).filter((id) => this.terms.has(id)) });
  }

  // One entry for this machine's consoles (Enter shows them, opening one if there are none),
  // and one under it per console: a click goes to it, F2 renames it.
  private consoleNode(cons: consoles.Console[]): Dict {
    const act = (id: string, label: string, key?: string) => ({ id, label, enabled: true, ...(key ? { key } : {}) });
    return { id: consoles.NODE, label: "Consoles", icon: "terminal", badge: cons.length ? String(cons.length) : "", dim: !cons.length, can: ["console.new"],
      tooltip: cons.length ? "Shells on this machine, over whichever project is in front (Enter shows them)" : "No consoles yet: Enter, or Ctrl+Shift+N, opens one",
      actions: [act("console.show", "Show"), act("console.new", "New console")],
      children: cons.map((c) => ({ id: consoles.nodeOf(c.pane), label: c.name, name: c.name, nameMax: consoles.NAME_MAX, icon: "terminal", color: SHELL_COLOR, can: ["console.new"],
        tooltip: c.shell ? "a shell on this machine" : `running ${c.command}`,
        actions: [act("pane.focus", "Go to it"), act("pane.rename", "Rename… (F2)"), act("pane.close", "Close…", "x")] })) };
  }

  // a project without a tab goes back to the terminal UI's layout (gui.keepSolo: leave it)
  private async release(s: core.ProjectSnap): Promise<void> {
    const name = s.project.name;
    if (!s.up || s.project.layout !== "solo" || config().gui?.keepSolo === true) return;
    if (Date.now() - (this.relayoutAt.get(name) ?? 0) < 10_000) return;
    this.relayoutAt.set(name, Date.now());
    log(`${name}: back to the grid layout`);
    await core.setLayout(name, "grid");
    s.project.layout = undefined;
  }
  // The window is gone (closed, or crashed): the same for everything it showed, done by
  // processes that outlive this one.
  private releaseAll(): void {
    if (config().gui?.keepSolo === true) return;
    for (const name of this.shown) {
      try { Bun.spawn([core.CLI, "layout", name, "grid"], { stdio: ["ignore", "ignore", "ignore"] }).unref(); } catch (e) { log(`layout ${name} grid: ${errText(e)}`); }
    }
  }

  private alerts(snaps: core.ProjectSnap[]): void {
    for (const s of snaps) for (const peer of s.peers) {
      const key = `${s.project.name}/${peer.repo}`;
      const was = this.attn.get(key) ?? null;
      if ((peer.attn === "ask" || peer.attn === "wait") && peer.attn !== was) this.notify(peer.attn === "ask" ? `${key} is waiting for an answer` : `${key} finished its turn`, { alert: true });
      this.attn.set(key, peer.attn);
    }
  }

  // ---- the sidebar

  private projectNode(s: core.ProjectSnap): Dict {
    const name = s.project.name, p = s.project;
    const act = (id: string, label: string, key?: string, enabled = true) => ({ id, label, ...(key ? { key } : {}), enabled });
    const sep = { separator: true };
    const actions: Dict[] = s.up
      ? [act("project.open", "Show", "", true), act("project.hide", "Close its tab", "h", this.shown.has(name)), sep,
         act("project.add", "Add repos…", "a"), act("project.chat", "Chat with the peers", "c"), act("project.brief", "Brief the peers again", "b", !!p.lead)]
      : [act("project.open", "Start", "u", p.peers.length > 0), sep, act("project.add", "Add repos…", "a")];
    actions.push(act("project.files", "Open folder", "f"), act("project.ticket", "Ticket…", "t"), act("project.goal", "Goal…", "g"), act("project.color", "Color…"),
      act("project.readd", "Re-add a removed repo…", "U", (p.removed ?? []).length > 0), sep);
    if (s.up) actions.push(act("project.down", "Bring down…", "d"));
    actions.push(act("project.rename", "Rename… (F2)"), act("project.delete", "Delete project…", "x"));

    // the toolbar buttons that apply with this project highlighted (the window greys the rest)
    const projectCan = ["project.add", ...(s.state !== "UP" ? ["project.open"] : []), ...(s.up ? ["project.down", "pane.chat"] : [])];
    const settingUp = this.settingUp.has(name);
    const peerNode = (peer: core.PeerSnap): Dict => {
      const shells = s.panes.filter((x) => x.title !== tmux.PANEL_TITLE && core.shellRepo(tmux.label(x)) === peer.repo);
      // in a container or not: what its claude runs in when it runs, else what its profile does
      const boxed = peer.boxed ?? p.profile !== "host";
      const pa: Dict[] = [act("peer.focus", peer.pane ? "Go to its pane" : "Start", "", s.up || p.peers.length > 0), sep,
        act("peer.shell", "Shell in its environment", "h", !!peer.pane), act("peer.hostshell", "Host shell in its checkout", "H", s.up),
        act("peer.restart", "Relaunch…", "R", s.up && peer.state !== "occupied"), act("peer.index", "Rebuild symbol index", "i"), sep,
        act("peer.files", "Open folder", "f"), act("peer.lead", peer.repo === p.lead ? "Change the goal…" : "Make lead…", "l"), act("peer.model", "Model…", "m")];
      if (peer.state === "occupied") pa.push(act("peer.takeover", "Take over (stop the session holding it)…"));
      pa.push(sep, act("peer.rename", "Rename… (F2)"), act("peer.remove", "Close…", "x"));
      const cloning = settingUp && !existsSync(peer.path);
      return {
        // greyed while its Claude is not running here
        // a terminal like its shells (docker or not); a plain folder (a home directory) shows its path
        id: `r:${name}/${peer.repo}`, label: (peer.label || (isRepo(peer.path) ? peer.repo : `${tilde(peer.path)}/`)) + (peer.repo === p.lead ? " ★" : ""), icon: boxed ? "container-claude" : "terminal-claude",
        name: peer.label || (isRepo(peer.path) ? peer.repo : `${tilde(peer.path)}/`),
        can: [...projectCan, ...(peer.state === "live" ? ["pane.shell"] : []), ...(s.up ? ["pane.hostshell"] : [])],
        dim: cloning || peer.state === "down" || peer.state === "occupied",
        // what its icon shows (working while it is cloned); a file left by a Claude that is gone says nothing
        state: cloning ? "work" : peer.state === "live" ? peer.attn ?? "" : "", bold: peer.attn === "ask",
        badge: attnBadge(peer.attn), badgeColor: attnColor(peer.attn), actions: pa,
        tooltip: `${tilde(peer.path)}\n${cloning ? "being cloned" : peer.state}${peer.model ? " · " + peer.model : ""} · conversation ${peer.session.slice(0, 8)}`,
        // under its repo a shell needs no name of its own: a terminal icon, and where it runs
        children: shells.map((x) => {
          const inBox = !tmux.label(x).startsWith("host:") && boxed;
          return { id: `t:${name}/${x.id}`, label: x.name || (inBox ? "container shell" : "host shell"), name: x.name || (inBox ? "container shell" : "host shell"), icon: inBox ? "container" : "terminal", tooltip: tmux.label(x), color: SHELL_COLOR,
            can: [...projectCan, ...(peer.state === "live" ? ["pane.shell"] : []), "pane.hostshell"],
            actions: [act("pane.focus", "Go to it"), act("pane.rename", "Rename… (F2)"), act("pane.close", "Close…", "x")] };
        }),
      };
    };
    const chat = s.panes.find((x) => tmux.label(x) === `chat:${name}`);
    return {
      id: `p:${name}`, label: p.label || name, name: p.label || name, icon: "project", color: s.color, can: projectCan, dim: settingUp,
      badge: attnBadge(s.attn), badgeColor: attnColor(s.attn), actions,
      tooltip: [settingUp ? "Being set up: its repos are being cloned (a Start waits for them)" : "", p.goal ? `Goal: ${p.goal.split("\n")[0].slice(0, 160)}` : "", p.ticket ? `Ticket: ${p.ticket}` : "", `${p.mode === "shared" ? "one shared container" : "a container per repo"} · profile ${p.profile} · ${s.state}`].filter(Boolean).join("\n"),
      children: [...s.peers.map(peerNode), ...(chat ? [{ id: `t:${name}/${chat.id}`, label: "chat", color: CHAT_COLOR, actions: [act("pane.focus", "Go to it"), act("pane.close", "Leave the chat…", "x")] }] : [])],
    };
  }

  // ---- menus and keys

  private profileActions(): ProfileAction[] {
    try { return profile(defaultProfile()).actions ?? []; } catch { return []; }
  }

  // Bare Ctrl chords only where the shell and Claude do not need them (C, D, X, N, P, Z, O need
  // Shift). settings.json overrides: gui.keys an action's own keys, gui.keysOff the actions
  // with none (an empty gui.keys entry too, as before); `defaults` ignores both.
  private menus(defaults = false): Dict[] {
    const user = (defaults ? {} : config().gui?.keys ?? {}) as Record<string, string[] | string>;
    const own = (id: string) => ([] as string[]).concat(user[id] ?? []).map((k) => k.trim()).filter(Boolean);
    const off = new Set<string>(defaults ? [] : [...([] as string[]).concat(config().gui?.keysOff ?? []), ...Object.keys(user).filter((id) => user[id] !== undefined && user[id] !== null && !own(id).length)]);
    // a key given to an action is taken from the one it shipped on: one key, one action
    const claimed = new Set(Object.keys(user).filter((id) => !off.has(id)).flatMap(own).map(normKey));
    const item = (id: string, label: string, keys: string[] = [], key?: string): Dict => {
      const k = off.has(id) ? [] : own(id).length ? own(id) : keys.filter((x) => !claimed.has(normKey(x)));
      return { id, label, ...(k.length ? { shortcuts: k } : {}), ...(key ? { key } : {}) };
    };
    const sep = { separator: true };
    return [
      { title: "&my-claude", items: [
        item("app.new", "New project…", [], "n"),
        ...this.profileActions().map((a) => item(`profile.${a.key}`, `${a.label}…`, [], a.key)),
        item("app.undelete", "Undelete a project…", [], "u"), sep,
        { label: "Connect", items: [
          ...Object.entries((config().gui?.hosts ?? {}) as Record<string, { dest?: string; port?: number }>).sort(([a], [b]) => a.localeCompare(b))
            .map(([n, h]) => ({ id: `app.connect:${n}`, label: `${n}    ${h.dest}${h.port ? `:${h.port}` : ""}` })),
          ...(Object.keys(config().gui?.hosts ?? {}).length ? [sep] : []),
          { id: "app.quickconnect", label: "Quick connect…" }, { id: "app.disconnect", label: "Disconnect…" }, { id: "app.machines", label: "Manage machines…" }] },
        item("host.settings", "Settings…"), item("host.driver-restart", "Restart driver"), sep,
        item("host.quit", "Quit", ["Ctrl+Shift+Q"])] },
      { title: "&Project", items: [
        item("host.tab-next", "Next project", ["Ctrl+Tab"]), item("host.tab-prev", "Previous project"),
        item("host.sidebar", "Project list", ["Ctrl+`", "Ctrl+Shift+D"]), sep,
        item("project.add", "Add repos…"), item("pane.chat", "Chat with the peers", ["Meta+C"]),
        item("project.ticket", "Ticket…"), item("project.goal", "Goal…"), sep,
        item("project.hide", "Close this tab"), item("project.down", "Bring down…")] },
      { title: "P&ane", items: [
        item("pane.shell", "Shell in its environment", ["Ctrl+Shift+H"]), item("pane.hostshell", "Host shell in its checkout", ["Ctrl+Alt+H", "Ctrl+Alt+Shift+H"]),
        item("pane.restart", "Relaunch…", ["Ctrl+Shift+R"]), item("pane.close", "Close, or remove the peer…", ["Ctrl+W", "Ctrl+Shift+X"]), item("pane.rename", "Rename", ["F2"]), sep,
        item("host.zoom", "Zoom", ["Ctrl+Shift+Z"]), item("host.minimise", "Minimise", ["Ctrl+M", "Ctrl+Shift+M"]), item("host.restore", "Restore all minimised"), sep,
        item("host.pane-next", "Next pane", ["Ctrl+Shift+Tab", "Ctrl+Shift+O"]), item("host.pane-prev", "Previous pane", ["Ctrl+Shift+P"]),
        item("host.pane-left", "Pane to the left", ["Ctrl+Shift+Left"]), item("host.pane-right", "Pane to the right", ["Ctrl+Shift+Right"]),
        item("host.pane-up", "Pane above", ["Ctrl+Shift+Up"]), item("host.pane-down", "Pane below", ["Ctrl+Shift+Down"]), sep,
        item("host.paste", "Paste", ["Ctrl+Shift+V"]), item("host.copy", "Copy the selection", ["Ctrl+Shift+C"]),
        item("host.find", "Find in scrollback…", ["Ctrl+Shift+F"]), item("host.scroll-end", "Scroll to the end", ["Ctrl+Shift+End"]), item("host.clear-scrollback", "Clear scrollback")] },
      // shells on the machine of what is in front, in a panel over the project
      { title: "&Console", items: [
        item("console.new", "New console", ["Ctrl+Shift+N"]), item("host.consoles", "Show/hide the consoles"), sep,
        item("host.console-next", "Next console"), item("host.console-prev", "Previous console"), item("host.console-rename", "Rename this console…"), sep,
        item("host.console-pin", "Pin the consoles: over every project")] },
      { title: "&View", items: [
        item("host.sidebar-toggle", "Show/hide the projects sidebar", ["Ctrl+H"]), item("host.toolbar", "Toolbar over the list"), item("host.overview", "Overview: every terminal at once", ["Meta+Shift+W"]), item("host.fullscreen", "Full screen", ["F11"]), sep,
        item("host.pane-text-bigger", "This pane: bigger text", ["Ctrl+=", "Ctrl++"]), item("host.pane-text-smaller", "This pane: smaller text", ["Ctrl+-"]),
        item("host.pane-text-reset", "This pane: normal text size", ["Ctrl+0"]), sep,
        item("host.font-bigger", "All panes: bigger text", ["Ctrl+Shift+="]), item("host.font-smaller", "All panes: smaller text", ["Ctrl+Shift+-"]), item("host.font-reset", "All panes: normal text size", ["Ctrl+Shift+0"])] },
    ];
  }

  // ---- settings: settings.json as a form, each profile adding its own section

  private settingsSpec(): Dict {
    const cfg = config();
    const schemesDir = "/usr/share/qtermwidget6/color-schemes";
    const schemes = existsSync(schemesDir) ? readdirSync(schemesDir).filter((f) => f.endsWith(".colorscheme")).map((f) => f.replace(/\.colorscheme$/, "")).sort() : [];
    const sections: Dict = {
      general: { type: "object", title: "my-claude", order: ["profile", "defaultOrg", "githubToken", "sshKey", "chatName", "peersCli", "historyLimit", "panesPerWindow", "panel"], properties: {
        historyLimit: { type: "integer", title: "Lines tmux keeps per pane", minimum: 0, maximum: 2000000, default: 50000, description: "tmux holds these in memory (about 800 bytes a line), so it is bounded. The window keeps its own scrollback, unlimited and on disk. 0: leave tmux's own setting. Applies to panes started from now on." },
        profile: { type: "string", title: "Default profile", enum: Object.keys(profiles), description: "How a new project's Claude sessions are started" },
        defaultOrg: { type: "string", title: "Default GitHub organisation", placeholder: "acme", description: "A bare repo name means a repo of this organisation: adding \"billing\" clones acme/billing. Add repos lists its repos to pick from. Other organisations: org/repo." },
        chatName: { type: "string", title: "Your name in the peers' chat", placeholder: `${process.env.USER ?? "user"}-chat` },
        peersCli: { type: "string", title: "claude-peers CLI", placeholder: "~/claude-peers-mcp/cli.ts" },
        githubToken: { type: "string", format: "password", title: "GitHub token", placeholder: "paste a token to sign in (repo scope)",
          description: `${this.ghWho ? `gh is signed in to GitHub as ${this.ghWho}.` : "gh is not signed in to GitHub, so the repo browser sees public repos only."} A token pasted here goes to gh's credential store, and git uses it over https (gh auth setup-git); settings.json never holds it.` },
        sshKey: { type: "string", format: "path", title: "SSH key for GitHub", placeholder: "ssh's own (agent, ~/.ssh/config)",
          description: `${this.sshWho ? `ssh reaches GitHub as ${this.sshWho}.` : "ssh does not reach GitHub with a key yet."} Clones fall back to git@github.com with it when https cannot.` },
        panesPerWindow: { type: "integer", title: "Panes per window (terminal UI)", minimum: 1, maximum: 16, default: 6 },
        panel: { type: "boolean", title: "Side panel (terminal UI)", default: true } } },
      window: { type: "object", title: "Window", order: ["iconSet", "font", "fontSize", "scheme", "tint", "alternate", "transparency", "blur", "panesPerGroup", "scrollback", "copyOnSelect", "panes", "openOnStart", "dropdown", "keepSolo"], properties: {
        iconSet: { type: "string", title: "Icons", enum: iconSets(), default: "v4",
          description: `Built in: v2 (an agent's icon carries its badge), classic. Another set: a folder of SVGs in ${tilde(join(CONFIG_DIR, "icons"))}/<name>/ (console, docker, console-claude, docker-claude, project, tb-new-project); what it lacks comes from the built-in ones.` },
        font: { type: "string", title: "Terminal font", placeholder: "qterminal's" },
        fontSize: { type: "integer", title: "Font size", minimum: 0, maximum: 48, default: 0, description: "0: qterminal's" },
        ...(schemes.length ? { scheme: { type: "string", title: "Colour scheme", enum: ["", ...schemes], enumLabels: ["my-claude's: each project's colour in its terminals", ...schemes] } } : {}),
        tint: { type: "integer", title: "Project colour in the terminals", minimum: 0, maximum: 100, default: 35, description: "How much of a project's colour the background of its terminals takes, with my-claude's own colour scheme. 0: none." },
        alternate: { type: "boolean", title: "Neighbouring panes in two shades", default: true },
        transparency: { type: "integer", title: "Transparency of the terminals", minimum: 0, maximum: 95, default: 0, description: "Percent. What is behind the window shows through the terminals' background; text, headers and the lists stay solid. 0: off." },
        blur: { type: "boolean", title: "Blur what shows through", default: true, description: "Asked of KWin; needs its Blur effect on." },
        panesPerGroup: { type: "integer", title: "Panes on screen at once", minimum: 1, maximum: 16, default: 4, description: "A project with more panes shows them in groups of this many; Ctrl+Shift+Tab walks through them all." },
        scrollback: { type: "integer", title: "Scrollback lines", minimum: 0, maximum: 100000000, default: 0, description: "0: unlimited, kept on disk under ~/.cache/my-claude/scrollback. A number keeps that many lines in memory instead." },
        copyOnSelect: { type: "boolean", title: "Selecting copies to the clipboard", default: true },
        panes: { type: "string", title: "Panes", enum: ["native", "view"], enumLabels: ["native: the window is each pane's terminal", "view: tmux draws each pane"], default: "native", description: "native gives the window its own scrollback, selection and keys (Ctrl-b reaches the program). view is the fallback: a tmux client inside each pane." },
        openOnStart: { type: "boolean", title: "Open running projects at start", default: true },
        dropdown: { type: "boolean", title: "Dropdown mode (Guake style)", default: false, description: "Always full screen, hidden when another window takes the focus, brought back with the show/hide key (Ctrl+Alt+T)." },
        keepSolo: { type: "boolean", title: "Leave projects one pane per tmux window when their tab closes", default: false, description: "Off: a project without a tab goes back to the terminal UI's tiled layout and side panel" } } },
    };
    const values: Dict = {
      general: { profile: cfg.profile ?? "host", defaultOrg: cfg.clone?.defaultOrg ?? "", sshKey: cfg.clone?.sshKey ?? "", chatName: cfg.chat?.name ?? "", peersCli: cfg.peers?.cli ?? "", historyLimit: cfg.historyLimit === undefined ? 50000 : Number(cfg.historyLimit) || 0, panesPerWindow: Number(cfg.panesPerWindow) || 6, panel: cfg.panel !== false },
      window: { iconSet: String(cfg.gui?.iconSet ?? "v4"), font: cfg.gui?.font ?? "", fontSize: Number(cfg.gui?.fontSize) || 0, scheme: cfg.gui?.scheme ?? "", tint: cfg.gui?.tint === undefined ? 35 : Number(cfg.gui.tint) || 0, alternate: cfg.gui?.alternate !== false, hosts: Object.entries((cfg.gui?.hosts ?? {}) as Record<string, { dest?: string; port?: number }>).map(([n, h]) => `${n} ${h.dest}${h.port ? `:${h.port}` : ""}`).join("\n"), transparency: Number(cfg.gui?.transparency) || 0, blur: cfg.gui?.blur !== false, panesPerGroup: Number(cfg.gui?.panesPerGroup) || 4, scrollback: Number(cfg.gui?.scrollback) || 0, copyOnSelect: cfg.gui?.copyOnSelect !== false, dropdown: cfg.gui?.dropdown === true, panes: cfg.gui?.panes === "view" ? "view" : "native", openOnStart: cfg.gui?.openOnStart !== false, keepSolo: cfg.gui?.keepSolo === true },
    };
    sections.remote = { type: "object", title: "Remote", description: "Other machines' projects in a window here, over ssh. The other machine needs my-claude and tmux; its daemon's own ssh port (2222) or its sshd will do.", order: ["hosts"], properties: {
        hosts: { type: "string", format: "multiline", title: "Machines", description: "One per line: a name, then user@host[:port]. Each one's projects join this window when it is connected (the Connect menu), and it gets a \"my-claude <name>\" launcher in the application menu. Example: server you@server:2222" },
    } };
    values.remote = { hosts: values.window.hosts };
    // Shortcuts: a row per action, its shipped keys, a key of the user's own, on or off
    const user = (cfg.gui?.keys ?? {}) as Record<string, string[] | string>;
    const own = (id: string) => ([] as string[]).concat(user[id] ?? []).map((k) => k.trim()).filter(Boolean);
    const off = new Set<string>([...([] as string[]).concat(cfg.gui?.keysOff ?? []), ...Object.keys(user).filter((id) => user[id] !== undefined && user[id] !== null && !own(id).length)]);
    const toggle = cfg.gui?.toggleKey === undefined ? "Ctrl+Alt+T" : String(cfg.gui.toggleKey);
    const rows: Dict[] = [{ id: "global.toggle", action: "Show / hide my-claude, from anywhere", stock: "Ctrl+Alt+T", global: true,
      tip: "A desktop-wide key, like a drop-down terminal's: set here, it is set in KDE too (System Settings › Shortcuts: \"my-claude (show/hide)\"). Elsewhere bind a key to: my-claude gui --toggle" }];
    for (const m of this.menus(true)) for (const i of (m.items as Dict[]).filter((x) => x.id))
      rows.push({ id: i.id, action: `${String(m.title).replace("&", "")} › ${i.label}`, stock: ((i.shortcuts as string[] | undefined) ?? []).join(", ") });
    sections.shortcuts = { type: "object", title: "Shortcuts", order: ["keys"], properties: {
      keys: { type: "array", format: "keys", title: "", rows, system: true,
        hint: "Click a Custom key cell, then press the keys (Esc clears it). Untick Enabled to turn an action's keys off. A key another action has: you are asked, and that action is turned off. A key the desktop holds is refused." } } };
    values.shortcuts = { keys: rows.map((r) => r.id === "global.toggle"
      ? { id: r.id, custom: toggle && normKey(toggle) !== normKey("Ctrl+Alt+T") ? toggle : "", enabled: toggle !== "" }
      : { id: r.id, custom: own(r.id).join(", "), enabled: !off.has(r.id) }) };
    const order = ["general", "window", "remote", "shortcuts"];
    for (const [pname, prof] of Object.entries(profiles)) {
      if (!prof.schema) continue;
      sections[`profile:${pname}`] = { title: `Profile: ${pname}`, ...prof.schema, type: "object" };
      values[`profile:${pname}`] = cfg[pname] ?? {};
      order.push(`profile:${pname}`);
    }
    return { schema: { type: "object", title: "Settings", order, properties: sections }, values };
  }

  private saveSettings(v: Dict): void {
    const blank = (x: unknown) => (x === "" || x === undefined ? null : x); // an emptied field is unset, the default applies
    const g = v.general ?? {}, w = { ...(v.window ?? {}), ...(v.remote ?? {}) };
    // shortcuts: an action's own key (none: the shipped ones), and the actions turned off
    const keyRows = Array.isArray(v.shortcuts?.keys) ? (v.shortcuts.keys as Dict[]) : null;
    const keys: Dict = {};
    let keysOff: string[] | null = null, toggleNew: string | null = null;
    if (keyRows) {
      keysOff = [];
      for (const r of keyRows) {
        const id = String(r.id ?? ""), custom = String(r.custom ?? "").trim(), on = r.enabled !== false;
        if (!id) continue;
        if (id === "global.toggle") { toggleNew = on ? custom || "Ctrl+Alt+T" : ""; continue; }
        keys[id] = custom ? custom.split(",").map((x) => x.trim()).filter(Boolean) : null;
        if (!on) keysOff.push(id);
      }
    }
    // new sign-in details, or another organisation: checked and the list fetched behind the form
    const token = String(g.githubToken ?? "").trim(), before = config().clone ?? {};
    if (token || String(g.sshKey ?? "") !== String(before.sshKey ?? "") || String(g.defaultOrg ?? "") !== String(before.defaultOrg ?? "")) {
      void this.refreshAuth(token, String(g.defaultOrg ?? "")).catch((e) => this.fail(e, "GitHub"));
    }
    const patch: Dict = {
      profile: g.profile || null,
      clone: { defaultOrg: blank(g.defaultOrg), sshKey: blank(g.sshKey) },
      chat: { name: blank(g.chatName) },
      peers: { cli: blank(g.peersCli) },
      historyLimit: Number(g.historyLimit) === 50000 ? null : Math.max(0, Number(g.historyLimit) || 0),
      panesPerWindow: Number(g.panesPerWindow) === 6 ? null : Number(g.panesPerWindow) || null,
      panel: g.panel === false ? false : null,
      gui: { ...(keyRows ? { keys, keysOff: keysOff?.length ? keysOff : null } : {}), iconSet: !w.iconSet || w.iconSet === "v4" ? null : String(w.iconSet), font: blank(w.font), fontSize: Number(w.fontSize) || null, scheme: blank(w.scheme), tint: w.tint === undefined || Number(w.tint) === 35 ? null : Math.max(0, Math.min(100, Number(w.tint) || 0)), alternate: w.alternate === false ? false : null, transparency: Number(w.transparency) > 0 ? Math.min(95, Number(w.transparency)) : null, blur: w.blur === false ? false : null, panesPerGroup: !Number(w.panesPerGroup) || Number(w.panesPerGroup) === 4 ? null : Math.max(1, Math.min(16, Number(w.panesPerGroup))), scrollback: Number(w.scrollback) > 0 ? Number(w.scrollback) : null, copyOnSelect: w.copyOnSelect === false ? false : null, panes: w.panes === "view" ? "view" : null, openOnStart: w.openOnStart === false ? false : null, dropdown: w.dropdown === true ? true : null, keepSolo: w.keepSolo === true ? true : null },
    };
    for (const [k, section] of Object.entries(v)) {
      if (!k.startsWith("profile:")) continue;
      patch[k.slice(8)] = Object.fromEntries(Object.entries(section as Dict).map(([f, val]) => [f, blank(val)]));
    }
    // machines: the whole list replaces the old one, and the launchers follow
    if (typeof w.hosts === "string") {
      const hosts: Dict = Object.fromEntries(Object.keys(config().gui?.hosts ?? {}).map((k) => [k, null]));
      for (const line of w.hosts.split("\n").map((l: string) => l.trim()).filter(Boolean)) {
        const [n, d] = line.split(/\s+/);
        if (!n || !d) continue;
        const m = /^(.*?)\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(d) ?? /^([^:]+):(\d+)$/.exec(d);
        const dest = m ? (m.length === 4 ? m[1] + m[2] : m[1]) : d, port = m ? (m.length === 4 ? m[3] : m[2]) : undefined;
        hosts[n] = { dest, port: port ? Number(port) : null };
      }
      patch.gui = { ...(patch.gui ?? {}), hosts };
    }
    const toggleChanged = toggleNew !== null && toggleNew !== String(config().gui?.toggleKey ?? "Ctrl+Alt+T");
    if (toggleChanged) patch.gui = { ...(patch.gui ?? {}), toggleKey: toggleNew || "" };
    const cfg = saveConfig(patch);
    if (toggleChanged) {
      try { install(); } catch (e) { this.notify(`global key: ${errText(e)}`, { error: true }); }
      this.send({ op: "globalKey", keys: toggleNew });
      this.notify(toggleNew ? `${toggleNew} now shows and hides my-claude from anywhere` : "no global key for my-claude");
    }
    if (typeof w.hosts === "string") { try { install(); } catch (e) { this.notify(`menu launchers: ${errText(e)}`, { error: true }); } }
    this.applyLook(cfg);
    this.notify("settings saved");
    this.requestSync();
  }
  private applyLook(cfg: Dict): void {
    const g = cfg.gui ?? {};
    const set = String(g.iconSet ?? "v4"), dir = join(CONFIG_DIR, "icons", set);
    this.send({ op: "look", iconSet: set, iconDir: existsSync(dir) ? dir : "", scrollback: Number(g.scrollback) > 0 ? Number(g.scrollback) : -1, copyOnSelect: g.copyOnSelect !== false, dropdown: g.dropdown === true, clipboardFromPrograms: g.clipboardFromPrograms !== false,
      seedLines: Math.max(0, Math.min(2000000, g.seedLines === undefined ? 50000 : Number(g.seedLines) || 0)),
      perGroup: Math.max(1, Math.min(16, Number(g.panesPerGroup) || 4)), transparency: Math.max(0, Math.min(95, Number(g.transparency) || 0)), blur: g.blur !== false, scheme: g.scheme ?? "", tint: g.tint === undefined ? 35 : Math.max(0, Math.min(100, Number(g.tint) || 0)), alternate: g.alternate !== false, scrollbackCapGB: Number(g.scrollbackCapGB) > 0 ? Number(g.scrollbackCapGB) : 20 });
    if (cfg.gui?.font || cfg.gui?.fontSize) this.send({ op: "font", ...(cfg.gui.font ? { family: cfg.gui.font } : {}), ...(cfg.gui.fontSize ? { size: cfg.gui.fontSize } : {}) });
  }

  // ---- what the window reports

  private onEvent(ev: Dict): void {
    switch (ev.ev) {
      case "hello": this.applyLook(config()); if (config().gui?.toggleKey !== undefined) this.send({ op: "globalKey", keys: String(config().gui.toggleKey) }); break;
      case "list": this.lists.shift()?.(ev); break;
      case "answer": {
        const done = this.asks.get(ev.id);
        this.asks.delete(ev.id);
        done?.(ev.cancelled ? null : (ev.values ?? {}));
        break;
      }
      case "opened": if (this.pendingFocus === ev.id) { this.send({ op: "focus", id: ev.id }); this.pendingFocus = null; } break;
      case "exited": case "closed":
        // Its view ended: the pane closed, or only the view did (prefix+d, prefix+n). The
        // next look reopens what still has a pane.
        this.terms.delete(ev.id);
        this.sent.delete(`term:${ev.id}`);
        setTimeout(() => this.requestSync(), 250);
        break;
      case "nudge":
        if (ev.focus) { this.pendingFocus = String(ev.focus); this.pendingFocusAge = 0; }
        this.requestSync();
        break;
      case "tab-close": this.hide(String(ev.tab)); break;
      // a pane's own colour scheme, kept by what the pane is (its tree entry), not its tmux id
      case "pane-scheme": { const k = this.terms.get(String(ev.id))?.skey; if (k) this.remember("paneSchemes", k, ev.scheme ? String(ev.scheme) : null); break; }
      case "pane-text": { const k = this.terms.get(String(ev.id))?.skey; if (k) this.remember("paneText", k, Number(ev.step) || null); break; }
      // a program in a pane asked the terminal to notify (OSC 9, OSC 777)
      case "note": { const t = this.terms.get(String(ev.id)); this.notify(`${t ? `${t.tab}/${t.title}` : ev.id}: ${[ev.title, ev.body].filter(Boolean).join(": ")}`, { alert: true }); break; }
      case "seen": { // looked at: a finished turn is read, as mail is once opened (a question stays until answered)
        const m = /^r:([^/]+)\/(.+)$/.exec(this.terms.get(String(ev.id))?.node ?? "");
        if (m && attention(m[1], m[2]) === "wait") { clearAttention(m[1], m[2]); this.requestSync(); }
        break;
      }
      case "select": this.go(String(ev.node), false); break;
      case "activate": this.go(String(ev.node), true); break;
      case "action": void this.onAction(ev).catch((e) => this.fail(e)); break;
      case "rename":
        if (String(ev.id ?? "").startsWith(`${consoles.TAB}/`)) void this.consoleRename(String(ev.id).slice(consoles.TAB.length + 1), String(ev.name ?? "")).catch((e) => this.fail(e, "rename"));
        else void this.onRename(String(ev.node ?? ""), String(ev.name ?? "")).catch((e) => this.fail(e, "rename"));
        break;
      case "open-path": void this.openPath(String(ev.id ?? ""), String(ev.path ?? "")).catch((e) => this.fail(e, "open")); break;
      case "settings": try { this.saveSettings(ev.values ?? {}); } catch (e) { this.fail(e, "settings"); } break;
      case "settings-open": this.send({ op: "settings", ...this.settingsSpec(), open: true }); break;
      case "quit": log("window closed"); this.flushPrefs(); this.releaseAll(); process.exit(0);
    }
  }

  // Per-pane preferences (its colour scheme, its text size), kept under "<project>/<pane>":
  // in memory at once, on disk 5 seconds after the last change and when the window closes.
  private pendingPrefs: Record<string, Record<string, unknown>> = {};
  private prefsTimer: ReturnType<typeof setTimeout> | null = null;
  private prefs(kind: string): Record<string, unknown> {
    return { ...(config().gui?.[kind] ?? {}), ...Object.fromEntries(Object.entries(this.pendingPrefs[kind] ?? {}).filter(([, v]) => v !== null)) , ...Object.fromEntries(Object.entries(this.pendingPrefs[kind] ?? {}).filter(([, v]) => v === null).map(([k]) => [k, undefined])) };
  }
  private remember(kind: string, key: string, value: unknown): void {
    (this.pendingPrefs[kind] ??= {})[key] = value;
    const t = this.terms.get([...this.terms.keys()].find((id) => this.terms.get(id)?.skey === key) ?? "");
    if (t) this.sent.delete(`term:${t.id}`); // what is sent next carries the new value
    if (this.prefsTimer) clearTimeout(this.prefsTimer);
    this.prefsTimer = setTimeout(() => this.flushPrefs(), 5000);
  }
  private flushPrefs(): void {
    if (this.prefsTimer) { clearTimeout(this.prefsTimer); this.prefsTimer = null; }
    if (!Object.keys(this.pendingPrefs).length) return;
    saveConfig({ gui: this.pendingPrefs });
    this.pendingPrefs = {};
  }

  private hide(name: string): void {
    if (!this.shown.has(name)) return;
    this.shown.delete(name);
    this.hidden.add(name);
    this.requestSync();
  }
  private show(name: string): void {
    this.hidden.delete(name);
    this.shown.add(name);
    this.pendingTab = name;
    this.requestSync();
  }

  // A click selects (go to what is already there); Enter or a double-click activates
  // (start what is not).
  private go(node: string, activate: boolean): void {
    if (node === consoles.NODE) { if (activate) void this.consoleShow().catch((e) => this.fail(e)); return; }
    if (consoles.paneOf(node)) { this.send({ op: "focus", id: `${consoles.TAB}/${consoles.paneOf(node)}` }); return; }
    const t = this.target({ node });
    const s = this.snap(t.name);
    if (!s || !t.name) return;
    const name = t.name;
    if (t.pane && this.terms.has(`${name}/${t.pane}`)) { this.send({ op: "focus", id: `${name}/${t.pane}` }); return; }
    if (node.startsWith("p:") && this.shown.has(name)) { this.send({ op: "tab", tab: name, focus: true }); return; }
    if (!activate) return;
    void this.openProject(name, t.pane ? `${name}/${t.pane}` : null).catch((e) => this.fail(e));
  }

  private async openProject(name: string, focus: string | null = null): Promise<void> {
    // work on it under way (its repos being cloned in): decide on what that leaves
    const s = this.active.has(name)
      ? await this.chains.get(name)!.then(async () => (await core.snapshot()).find((x) => x.project.name === name) ?? null)
      : this.snap(name);
    if (!s) return;
    const missing = s.peers.some((x) => x.state === "down");
    if (!s.up || missing) {
      if (!s.project.peers.length) throw new Error(`${name} is unconfigured`);
      // a conversation already open in a Claude my-claude did not start: offer to take it over, up front
      const taken: string[] = [];
      for (const x of s.peers.filter((y) => y.state === "occupied")) {
        const lock = lockInfo(x.path);
        const who = `pid ${occupantPid(x.path, whoOf(s.project, x)) ?? "?"}${lock?.started ? `, since ${String(lock.started).slice(11, 16)}` : ""}`;
        if (await this.ask({ title: `Take over ${x.repo}?`, ok: "Take over", cancel: "Leave it",
          text: `${x.repo}'s conversation is open in a Claude session started outside my-claude (${who}), in ${tilde(x.path)}.\n\nTake over: that session ends and the conversation carries on here.` })) taken.push(x.repo);
      }
      if (!taken.length && s.peers.every((x) => x.state === "occupied")) { this.notify(`${name}: left as it is`); return; }
      await this.work(name, `starting ${name}…`, async () => {
        await core.ensureBinary();
        for (const repo of taken) await core.takeover(name, repo);
        for (const r of await core.up(name)) if (r.action === "skipped") this.notify(`${r.repo}: ${r.detail}`);
        await core.syncGroupNow(name);
      });
    }
    if (focus) { this.pendingFocus = focus; this.pendingFocusAge = 0; }
    this.show(name);
  }

  // A path Ctrl+clicked in a pane: from the pane's folder, else its repo's, opened on the desktop.
  private async openPath(id: string, raw: string): Promise<void> {
    const [name, pane] = split2(id);
    const path = raw.replace(/:\d+(:\d+)?$/, "").replace(/^~(?=\/)/, homedir());
    const here = (await sh("tmux", ["display-message", "-p", "-t", pane, "#{pane_current_path}"], { ok: true })).trim();
    const repo = this.snap(name)?.peers.find((x) => x.repo === this.byPane(name, pane).repo)?.path;
    for (const dir of [here, repo].filter((d): d is string => !!d)) {
      const abs = resolve(dir, path);
      if (await stat(abs).then(() => true, () => false)) { this.send({ op: "browse", path: abs }); return; }
    }
    this.notify(`no ${path} in ${tilde(here || homedir())}`, { error: true });
  }

  // A name typed over an entry (F2): its display name, the default again when emptied.
  private async onRename(node: string, raw: string): Promise<void> {
    const label = raw.trim().slice(0, 64);
    let m: RegExpExecArray | null;
    if (consoles.paneOf(node)) return this.consoleRename(consoles.paneOf(node), label);
    if ((m = /^p:([^/]+)$/.exec(node))) core.renameProject(m[1], label);
    else if ((m = /^r:([^/]+)\/(.+)$/.exec(node))) core.renamePeer(m[1], m[2], label);
    else if ((m = /^t:[^/]+\/(%\d+)$/.exec(node))) await tmux.renamePane(m[1], label);
    else return;
    await this.sync();
  }

  private async onAction(ev: Dict): Promise<void> {
    const a = String(ev.action);
    // the console meant: its entry's, from the list; else the one with the keyboard
    const held = String(ev.id ?? "").startsWith(`${consoles.TAB}/`) ? String(ev.id).slice(consoles.TAB.length + 1) : "";
    const cid = ev.focus === "tree" ? consoles.paneOf(String(ev.node ?? "")) : held || consoles.paneOf(String(ev.node ?? ""));
    if (a === "console.new") return this.consoleNew();
    if (a === "console.show") return this.consoleShow();
    if (a === "pane.close" && cid) return this.consoleClose(cid);
    if (a === "pane.focus" && cid) { this.send({ op: "focus", id: `${consoles.TAB}/${cid}` }); return; }
    const t = this.target(ev);
    const name = t.name ?? "";
    const project = () => { if (!this.snap(name)) throw new Error("pick a project first (its tab, or its entry in the list)"); return name; };
    const peer = () => { project(); if (!t.repo || !this.snap(name)!.project.peers.some((x) => x.repo === t.repo)) throw new Error("pick a peer first (its pane, or its entry in the list)"); return t.repo; };
    if (a.startsWith("profile.")) return this.profileAction(a.slice(8));
    if (a.startsWith("app.connect:")) {
      const n = a.slice(12);
      const h = (config().gui?.hosts ?? {})[n] as { dest?: string; port?: number; key?: string; jump?: string } | undefined;
      if (h?.dest) this.connectMachine(n, h);
      return;
    }
    switch (a) {
      case "app.new": return this.newProject();
      case "app.machines": return this.machines();
      case "app.disconnect": {
        const names = Object.keys(config().gui?.hosts ?? {});
        const hs = (config().gui?.hosts ?? {}) as Record<string, { dest?: string; port?: number }>;
        const v = await this.ask({ title: "Disconnect", schema: { type: "object", properties: { which: { type: "string", title: "Machine", format: "table", enum: names,
          columns: ["Machine", "Host"], enumRows: names.map((n) => [n, `${hs[n].dest ?? ""}${hs[n].port ? `:${hs[n].port}` : ""}`]) } } }, values: { which: names[0] }, ok: "Disconnect" });
        if (v?.which) {
          this.send({ op: "disconnect", machine: String(v.which) });
          saveConfig({ gui: { connected: ([] as string[]).concat(config().gui?.connected ?? []).filter((x) => x !== String(v.which)) } });
        }
        return;
      }
      case "app.quickconnect": {
        const v = await this.ask({ title: "Quick connect", text: "Another machine's projects in a window here, over ssh: user@host, host:port or user@[IPv6]:port.",
          schema: { type: "object", required: ["dest"], properties: { dest: { type: "string", title: "Machine", placeholder: "you@server:2222" } } }, values: {}, ok: "Connect" });
        if (v?.dest) { const d = String(v.dest).trim(); this.connectMachine(d.replace(/^.*@/, "").replace(/[\[\]:]/g, "_"), { dest: d }); }
        return;
      }
      case "app.undelete": return this.undelete();
      case "project.open": return this.openProject(project());
      case "project.hide": return this.hide(project());
      case "project.down": return this.projectDown(project());
      case "project.add": return this.projectAdd(project());
      case "project.ticket": return this.projectTicket(project());
      case "project.goal": return this.projectGoal(project());
      // the window opens it: it knows which machine the folder is on
      case "project.files": return this.send({ op: "browse", path: join(PROJECTS, project()) });
      case "peer.files": { const repo = peer(); const at = this.snap(name)?.peers.find((x) => x.repo === repo)?.path; if (at) this.send({ op: "browse", path: at }); return; }
      case "project.color": return this.projectColor(project());
      case "project.readd": return this.projectReadd(project());
      case "project.delete": return this.projectDelete(project());
      case "project.brief": return this.work(project(), `briefing ${name}…`, async () => { this.notify((await core.brief(await core.status(name))).join("; ")); });
      case "project.chat": case "pane.chat": return this.openPane(project(), () => core.openChat(name));
      case "peer.focus": return this.openProject(project(), t.pane ? `${name}/${t.pane}` : null);
      case "peer.shell": case "pane.shell": { const repo = peer(); return this.openPane(name, () => core.openShell(name, repo, "env")); }
      case "peer.hostshell": case "pane.hostshell": { const repo = peer(); return this.openPane(name, () => core.openShell(name, repo, "host")); }
      case "peer.restart": case "pane.restart": return this.peerRestart(name, peer());
      case "peer.index": { const repo = peer(); void core.index(name, repo); return this.notify(`rebuilding the symbol index of ${repo}`); }
      case "peer.lead": return this.peerLead(name, peer());
      case "peer.model": return this.peerModel(name, peer());
      case "peer.takeover": return this.peerTakeover(name, peer());
      case "project.rename": case "peer.rename": case "pane.rename": // F2's editor, in place
        if (ev.node) this.send({ op: "edit", node: String(ev.node) });
        return;
      case "peer.remove": return this.peerRemove(name, peer());
      case "pane.focus": if (t.pane) this.send({ op: "focus", id: `${name}/${t.pane}` }); return;
      case "pane.close": return this.paneClose(project(), t);
      default: log(`unknown action ${a}`);
    }
  }

  // ---- the actions

  private async consoleNew(): Promise<void> {
    await this.work(consoles.TAB, "", async () => {
      const pane = await consoles.open();
      this.pendingFocus = `${consoles.TAB}/${pane}`;
      this.pendingFocusAge = 0;
    });
  }
  // Shown over the tab in front; with none yet, the first one is opened.
  private async consoleShow(): Promise<void> {
    if (!(await consoles.list()).length) return this.consoleNew();
    this.send({ op: "consoles", tab: consoles.TAB, show: true });
  }
  private async consoleRename(pane: string, name: string): Promise<void> {
    await consoles.rename(pane, name);
    await this.sync();
  }
  // Only a console running something besides its shell is asked about.
  private async consoleClose(pane: string): Promise<void> {
    const c = (await consoles.list()).find((x) => x.pane === pane);
    if (!c) return;
    if (!c.shell && !await this.confirm(`Close ${c.name}?`, `${c.name} is running ${c.command}: closing the console ends it.`, "Close")) return;
    await consoles.close(pane);
    this.requestSync();
  }

  // A shell or the chat: a window of the project's session, shown as soon as it exists.
  private async openPane(name: string, make: () => Promise<string | null>): Promise<void> {
    const s = this.snap(name);
    if (!s?.up) throw new Error(`${name} is not running: start it first`);
    if (!this.shown.has(name)) this.show(name);
    await this.work(name, "", async () => {
      if (this.snap(name)?.project.layout !== "solo") await core.setLayout(name, "solo");
      const pane = await make();
      if (pane) { this.pendingFocus = `${name}/${pane}`; this.pendingFocusAge = 0; }
    });
  }

  // Another machine's projects in this window, as "<project>@<name>": the window runs
  // that machine's driver over ssh, and reaches its tmux the same way.
  private connectMachine(name: string, h: { dest?: string; port?: number; key?: string; jump?: string }): void {
    let dest = String(h.dest), port = h.port ? String(h.port) : "";
    const hp = /^(.*?)\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(dest) ?? /^([^:]+):(\d+)$/.exec(dest);
    if (hp) { const two = hp.length === 4; dest = two ? hp[1] + hp[2] : hp[1]; port = port || (two ? hp[3] ?? "" : hp[2]); }
    const run = process.env.XDG_RUNTIME_DIR ?? "/tmp";
    const base = [process.env.MC_TERM_SSH || "ssh", "-T", "-o", "ControlMaster=auto", "-o", `ControlPath=${run}/my-claude/ssh-%C`, "-o", "ControlPersist=60",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "Compression=yes", "-o", "BatchMode=yes",
      ...(port ? ["-p", port] : []), ...(h.key ? ["-i", h.key.replace(/^~/, homedir()), "-o", "IdentitiesOnly=yes"] : []), ...(h.jump ? ["-J", h.jump] : [])];
    const remoteCmd = String(config().gui?.remoteCommand ?? "my-claude _gui");
    const driver = [...base, dest, `bash -lc 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; exec ${remoteCmd} --stdio'`];
    this.send({ op: "connect", machine: name, driver, tmux: [...base, dest, "tmux"] });
    // a saved machine stays connected across restarts of the window
    const kept = ([] as string[]).concat(config().gui?.connected ?? []);
    if ((config().gui?.hosts ?? {})[name] && !kept.includes(name)) saveConfig({ gui: { connected: [...kept, name] } });
    this.notify(`connecting to ${name}…`);
  }

  // Saved machines, like a terminal program's saved sessions: host, user, port, key, jump host,
  // each with a "my-claude <name>" launcher.
  private async machines(): Promise<void> {
    type Host = { dest?: string; port?: number; key?: string; jump?: string };
    const hosts = (config().gui?.hosts ?? {}) as Record<string, Host>;
    const names = Object.keys(hosts).sort();
    const pick = await this.ask({ title: "Remote machines", text: "Machines whose projects open in a window here, over ssh. Each is also \"my-claude <name>\" in the application menu.",
      schema: { type: "object", properties: { which: { type: "string", title: "Machine", format: "table", enum: [...names, "+"], columns: ["Machine", "Host", "Port", "Key", "Jump host"],
        enumRows: [...names.map((n) => [n, hosts[n].dest ?? "", hosts[n].port ? String(hosts[n].port) : "", hosts[n].key ?? "", hosts[n].jump ?? ""]), ["+ Add a machine…", "", "", "", ""]] } } },
      values: { which: names[0] ?? "+" }, ok: "Edit…", cancel: "Close" });
    if (!pick) return;
    const old = pick.which === "+" ? null : String(pick.which);
    const h: Host = old ? hosts[old] : {};
    const user = h.dest?.includes("@") ? h.dest.split("@")[0] : process.env.USER ?? "";
    const host = h.dest ? h.dest.replace(/^.*@/, "") : "";
    const keys = existsSync(join(homedir(), ".ssh")) ? readdirSync(join(homedir(), ".ssh")).filter((f) => /^id_[a-z0-9_-]+$/.test(f)).map((f) => `~/.ssh/${f}`) : [];
    const v = await this.ask({ title: old ? `Machine: ${old}` : "Add a machine",
      schema: { type: "object", required: ["name", "host"], order: ["name", "host", "user", "port", "key", "jump", "action"], properties: {
        name: { type: "string", title: "Name", description: "What the launcher is called: my-claude <name>" },
        host: { type: "string", title: "Host", description: "Name or address (IPv6 as is, no brackets)" },
        user: { type: "string", title: "User" },
        port: { type: "integer", title: "Port", minimum: 0, maximum: 65535, default: 0, description: "0: ssh's default (22, or ~/.ssh/config). my-claude's own daemon listens on 2222." },
        key: { type: "string", title: "Private key", format: "path", enum: undefined, description: `Empty: ssh's own choice (your agent, ~/.ssh/config).${keys.length ? ` Here: ${keys.join(", ")}` : ""}` },
        jump: { type: "string", title: "Jump host", description: "Through another ssh host first (ssh -J), e.g. you@gateway" },
        action: { type: "string", title: "Then", enum: ["save", "open", "deploy", ...(old ? ["remove"] : [])], enumLabels: ["Save", "Save and open its projects now", "Save and deploy my-claude there (over ssh, into ~/.local)", ...(old ? ["Remove this machine"] : [])] } } },
      values: { name: old ?? "", host, user, port: h.port ?? 0, key: h.key ?? "", jump: h.jump ?? "", action: "save" }, ok: "OK" });
    if (!v) return;
    const name = String(v.name).trim().replace(/\s+/g, "-");
    const patch: Record<string, Host | null> = {};
    if (old && (old !== name || v.action === "remove")) patch[old] = null;
    const dest = `${v.user ? `${v.user}@` : ""}${String(v.host).trim()}`;
    if (v.action !== "remove") patch[name] = { dest, ...(Number(v.port) ? { port: Number(v.port) } : {}), ...(v.key ? { key: String(v.key) } : {}), ...(v.jump ? { jump: String(v.jump) } : {}) };
    saveConfig({ gui: { hosts: patch } });
    try { install(); } catch (e) { this.notify(`menu launchers: ${errText(e)}`, { error: true }); }
    this.notify(v.action === "remove" ? `${old} removed` : `${name} saved: "my-claude ${name}" is in the application menu`);
    if (v.action === "deploy") {
      const p = patch[name]!;
      await this.work(`*deploy-${name}`, `deploying to ${name}…`, async () => {
        const lines: string[] = [];
        const rc = await (await import("./deploy.ts")).deploy([p.dest!, ...(p.port ? ["--port", String(p.port)] : []), ...(p.key ? ["--identity", p.key.replace(/^~/, homedir())] : []), ...(p.jump ? ["--jump", p.jump] : [])],
          (m) => { lines.push(m); this.send({ op: "busy", text: `${name}: ${m}` }); });
        this.send({ op: "busy", text: "" });
        this.notify(rc === 0 ? `my-claude is on ${name}: ${lines.filter((l) => l.startsWith(p.dest!)).join("; ")}` : `deploying to ${name} failed (see the driver log)`, { error: rc !== 0 });
        if (rc === 0) this.connectMachine(name, p);
      });
    }
    if (v.action === "open") {
      const p = patch[name]!;
      void launch(["--remote", p.dest!, ...(p.port ? ["--port", String(p.port)] : []), ...(p.key ? ["--identity", p.key] : []), ...(p.jump ? ["--jump", p.jump] : [])]);
    }
  }

  // ssh to a saved machine, as the window does; argv to put a command after
  private sshTo(h: { dest?: string; port?: number; key?: string; jump?: string }): { argv: string[]; dest: string } {
    let dest = String(h.dest), port = h.port ? String(h.port) : "";
    const hp = /^(.*?)\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(dest) ?? /^([^:]+):(\d+)$/.exec(dest);
    if (hp) { const two = hp.length === 4; dest = two ? hp[1] + hp[2] : hp[1]; port = port || (two ? hp[3] ?? "" : hp[2]); }
    return { dest, argv: [process.env.MC_TERM_SSH || "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", ...(port ? ["-p", port] : []),
      ...(h.key ? ["-i", h.key.replace(/^~/, homedir()), "-o", "IdentitiesOnly=yes"] : []), ...(h.jump ? ["-J", h.jump] : []), dest] };
  }
  // my-claude on a machine, over its ssh: the command line, run in a login shell there
  private async onMachine(h: { dest?: string; port?: number; key?: string; jump?: string }, args: string[], timeoutMs = 600_000): Promise<{ ok: boolean; out: string }> {
    const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
    const cmd = `bash -lc ${q(`${REMOTE_PATH}${["my-claude", ...args].map(q).join(" ")}`)}`;
    const { argv } = this.sshTo(h);
    const proc = Bun.spawn([...argv, cmd], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { ok: code === 0, out: (out + err).trim() };
  }
  // Can the window put projects there? ssh answers, and my-claude is installed (its version).
  private async checkMachine(h: { dest?: string; port?: number; key?: string; jump?: string }): Promise<{ ok: boolean; why: string }> {
    const r = await this.onMachine(h, ["--version"], 12_000);
    if (r.ok && /^my-claude /m.test(r.out)) return { ok: true, why: r.out.split("\n").find((l) => l.startsWith("my-claude ")) ?? "" };
    if (/command not found|No such file|not found/i.test(r.out)) return { ok: false, why: "reachable, my-claude not installed (Deploy installs it)" };
    return { ok: false, why: `cannot connect: ${r.out.split("\n").pop()?.slice(0, 80) || "no answer"}` };
  }

  private async newProject(): Promise<void> {
    // where it runs: here, or a saved machine, each checked first so the choice says what works
    type Host = { dest?: string; port?: number; key?: string; jump?: string };
    const hosts = (config().gui?.hosts ?? {}) as Record<string, Host>;
    const names = Object.keys(hosts).sort();
    if (names.length) this.send({ op: "busy", text: "checking the machines…" });
    const checks = await Promise.all(names.map((n) => this.checkMachine(hosts[n]).catch(() => ({ ok: false, why: "check failed" }))));
    this.send({ op: "busy", text: "" });
    const v = await this.ask({ title: "New project", ok: "Create", schema: { type: "object", required: ["name"], order: ["machine", "name", "repos", "goal", "mode", "color"], properties: {
      ...(names.length ? { machine: { type: "string", title: "Machine", enum: ["", ...names],
        enumLabels: ["this machine", ...names.map((n, i) => `${n}   ${checks[i].ok ? "✓" : "✗"} ${checks[i].why}`)],
        description: "Where its Claude sessions run. A machine with ✗ cannot take projects until it is fixed (Connect › Manage machines…, or Deploy)." } } : {}),
      name: { type: "string", title: "Name" },
      repos: { type: "string", title: "Repos", placeholder: "~/src/api web acme/billing https://github.com/…/pull/12", description: "Paths, repo names, org/repo or URLs (a PR URL clones its branch), space separated. --branch B or --name N after one applies to it. A path is linked in, anything else is cloned fresh." },
      goal: { type: "string", title: "Goal", format: "multiline" },
      mode: { type: "string", title: "Containers", enum: ["per-repo", "shared"], enumLabels: ["one per repo", "one shared"], default: "per-repo" },
      color: { type: "string", title: "Color", enum: COLOR_CHOICES, default: COLOR_CHOICES[0] } } } });
    if (!v) return;
    const name = slug(String(v.name ?? ""));
    if (!name) throw new Error("that name has no usable characters (letters, digits, . _ -)");
    const machine = String(v.machine ?? "");
    if (!machine) return this.createProject(name, { goal: String(v.goal ?? ""), shared: v.mode === "shared", color: v.color }, String(v.repos ?? ""));
    // on another machine: made and started there with its own my-claude, then shown here
    const i = names.indexOf(machine);
    if (i >= 0 && !checks[i].ok) throw new Error(`${machine}: ${checks[i].why}`);
    const h = hosts[machine];
    const specs = core.splitRepoSpecs(String(v.repos ?? "").trim()); // before anything is made there
    await this.work(`${name}@${machine}`, `creating ${name} on ${machine}…`, async () => {
      // `fine`: what a retry meets after an earlier attempt failed further on
      const step = async (args: string[], fine?: RegExp) => {
        const r = await this.onMachine(h, args);
        if (!r.ok && !(fine && fine.test(r.out))) throw new Error(`${machine}: ${r.out.split("\n").pop()}`);
      };
      try {
        await step(["new", name, ...(v.goal ? ["--goal", String(v.goal)] : []), ...(v.color ? ["--color", String(v.color)] : []), ...(v.mode === "shared" ? ["--shared"] : [])], /project '[^']*' exists/);
        for (const spec of specs) await step(["add", name, ...spec.split(/\s+/), "--takeover"], /already in/);
        if (specs.length) await step(["up", name, "--no-attach", "--takeover"]);
      } finally {
        this.connectMachine(machine, h); // its projects in this window, a half-made one included
      }
      this.notify(`created ${name} on ${machine}`);
    });
  }

  private async createProject(name: string, o: { goal?: string; shared?: boolean; color?: string; ticket?: string }, repos: string): Promise<void> {
    await this.work(name, `creating ${name}…`, async () => {
      core.splitRepoSpecs(repos); // a line it cannot read leaves no empty project behind
      core.newProject(name, { goal: o.goal || undefined, shared: o.shared, color: o.color, ticket: o.ticket || undefined });
      if (!repos.trim()) { this.notify(`created ${name}; add repos to start it`); return; }
      this.settingUp.add(name);
      this.requestSync();
      try {
        await core.addRepos(name, repos, { log: (m) => this.progress(name, `${name}: ${m}`), takeover: true });
        await core.ensureBinary();
        await core.up(name, { takeover: true }); // its repos were just added: wanted here
        await core.syncGroupNow(name);
        this.show(name);
      } finally { this.settingUp.delete(name); }
    });
  }

  // Every machine's trash in one list, filtered by machine: this machine's at once, the
  // others' filled in as they answer. A project is restored where it was deleted.
  private async undelete(): Promise<void> {
    const hosts = (config().gui?.hosts ?? {}) as Record<string, { dest?: string; port?: number; key?: string; jump?: string }>;
    const names = Object.keys(hosts).sort();
    const here = hostname().split(".")[0];
    type Row = { m: string; t: Trashed };
    let rows: Row[] = core.trashed().map((t) => ({ m: ".", t }));
    if (!rows.length && !names.length) return this.notify("nothing in the trash");
    const choices = () => {
      const all = [...rows].sort((a, b) => b.t.when - a.t.when);
      return { enum: all.map((r) => `${r.m}|${r.t.dir}`),
        enumRows: all.map((r) => [r.t.name, r.m === "." ? here : r.m, r.t.peers.join(", ") || "-", stamp(r.t.when)]) };
    };
    const id = `ask-${++this.askSeq}`;
    const answer = this.ask({ title: "Undelete a project", ok: "Restore", schema: { type: "object", order: ["machine", "which"], properties: {
      ...(names.length ? { machine: { type: "string", title: "Machine", format: "filter", filters: "which", enum: ["*", ".", ...names],
        enumLabels: ["every machine", `this machine (${here})`, ...names] } } : {}),
      which: { type: "string", title: "Project", format: "table", columns: ["Project", "Machine", "Repos", "Deleted"], sort: [3, "desc"], ...choices() } } } }, id);
    for (const n of names) {
      void this.onMachine(hosts[n], ["undelete", "--json"], 20_000).then((r) => {
        try { if (r.ok) rows = [...rows, ...(JSON.parse(r.out.split("\n").pop() || "[]") as Trashed[]).map((t) => ({ m: n, t }))]; } catch {}
      }).finally(() => this.send({ op: "fill", id, key: "which", ...choices() }));
    }
    const v = await answer;
    if (!v?.which) return;
    const [m, dir] = [String(v.which).split("|")[0], String(v.which).split("|").slice(1).join("|")];
    if (m === ".") {
      // the project's own work, so a Start meanwhile waits for its clones
      const name = rows.find((r) => r.m === "." && r.t.dir === dir)?.t.name ?? "*trash";
      this.settingUp.add(name);
      await this.work(name, `restoring ${name}…`, async () => {
        try {
          // its record is back before the first clone starts: the list shows it, greyed
          const r = await core.undelete(dir, (msg) => { this.progress(name, msg); this.requestSync(); });
          this.notify(`restored ${r.name}${r.recloned.length ? `; cloned again: ${r.recloned.join(", ")}` : ""}${r.missing.length ? `; missing: ${r.missing.join(", ")}` : ""}${r.leftOut.length ? `; left out ${r.leftOut.join("; ")}` : ""}${r.notes.length ? `; ${r.notes.join("; ")}` : ""}`, { error: r.missing.length > 0 });
        } finally { this.settingUp.delete(name); }
      });
      return;
    }
    await this.work("*trash", `restoring on ${m}…`, async () => {
      const r = await this.onMachine(hosts[m], ["undelete", dir]);
      if (!r.ok) throw new Error(`${m}: ${r.out.split("\n").pop()}`);
      this.connectMachine(m, hosts[m]);
      this.notify(`${m}: ${r.out.split("\n").filter(Boolean).pop() ?? "restored"}`);
    });
  }

  private async profileAction(key: string): Promise<void> {
    const a = this.profileActions().find((x) => x.key === key);
    if (!a) return;
    let answers: string[] = [];
    if (a.prompts.length) {
      const props: Dict = {};
      a.prompts.forEach((q, i) => { props[`a${i}`] = q.kind === "choice" ? { type: "string", title: q.label, enum: q.choices ?? [], default: q.default ?? q.choices?.[0] } : { type: "string", title: q.label, default: q.default ?? "", ...(/descr/i.test(q.label) ? { format: "multiline" } : {}) }; });
      const v = await this.ask({ title: a.label, ok: a.label, schema: { type: "object", order: a.prompts.map((_, i) => `a${i}`), properties: props } });
      if (!v) return;
      answers = a.prompts.map((_, i) => String(v[`a${i}`] ?? ""));
    }
    await this.work("*profile", `${a.label}…`, async () => {
      const r = await a.run(answers);
      this.notify(r.message, { error: /fail|not found/i.test(r.message) });
      if (r.createProject) {
        core.newProject(r.createProject.name, { goal: r.createProject.goal, shared: r.createProject.shared, ticket: r.createProject.ticket });
        this.notify(`${r.message}; project ${r.createProject.name} created: add repos to start it`);
      }
    });
  }

  private async projectDown(name: string): Promise<void> {
    if (!(await this.confirm(`Bring ${name} down?`, `Its Claude sessions stop and their panes close. Records and conversations stay; Start resumes every one of them.`, "Bring down"))) return;
    await this.work(name, `stopping ${name}…`, async () => { await core.down(name); this.shown.delete(name); this.hidden.delete(name); });
  }

  // An organisation's repos, for the add dialog: gh when it is logged in (private ones
  // too), else GitHub's public API. Kept for ten minutes.
  private repoCache = new Map<string, { at: number; repos: { name: string; description: string }[] }>();
  private ghWho = "";
  // who gh is signed in as (for Settings), looked up off the critical path
  private async ghWhoami(): Promise<string> {
    if (!Bun.which("gh")) return (this.ghWho = "");
    return (this.ghWho = (await sh("gh", ["api", "user", "--jq", ".login"], { ok: true })).trim());
  }
  private sshWho = "";
  private async sshWhoami(): Promise<string> {
    const key = String(config().clone?.sshKey ?? "").replace(/^~/, homedir());
    const p = Bun.spawn(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...(key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : []), "git@github.com"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return (this.sshWho = /Hi ([^!]+)!/.exec(o + e)?.[1] ?? "");
  }
  // Sign-in details changed: gh takes a new token, then both ways in are checked and the
  // organisation's list fetched again, all behind the form; the status bar has the outcome.
  private async refreshAuth(token: string, org: string): Promise<void> {
    if (token) {
      const bad = await this.githubLogin(token);
      if (bad) { this.notify(`GitHub token not taken: ${bad}`, { error: true }); return; }
    }
    this.repoCache.clear();
    const [gh, ssh, repos] = await Promise.all([this.ghWhoami(), this.sshWhoami(), org ? this.orgRepos(org, 0).catch(() => null) : Promise.resolve(null)]);
    this.notify(`GitHub: ${gh ? `gh as ${gh}` : "gh not signed in"} · ${ssh ? `ssh as ${ssh}` : "no ssh key reaches it"}${org ? ` · ${repos ? `${repos.length} ${org} repos` : `${org}'s repos could not be listed`}` : ""}`, { error: !gh && !ssh });
  }
  // As setup_dev --token does: the token to gh's credential store, and git over https through gh.
  private async githubLogin(token: string): Promise<string | null> {
    if (!Bun.which("gh")) return "install the GitHub CLI (gh) first";
    const { GH_TOKEN: _a, GITHUB_TOKEN: _b, ...env } = process.env; // gh stores nothing while a token is in its environment
    const run = async (args: string[], input?: string) => {
      const p = Bun.spawn(["gh", ...args], { stdin: input === undefined ? "ignore" : "pipe", stdout: "ignore", stderr: "pipe", env });
      if (input !== undefined && p.stdin) { p.stdin.write(input); p.stdin.end(); }
      const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      return code === 0 ? null : err.trim().split("\n").pop() || `gh ${args[0]} failed`;
    };
    return (await run(["auth", "login", "--hostname", "github.com", "--with-token"], token + "\n")) ?? (await run(["auth", "setup-git", "--hostname", "github.com"]));
  }
  // An organisation's repos. The last list is kept on disk, so a dialog shows it at once and
  // swaps in the fresh one when it arrives; one fetch at a time per organisation.
  private repoFile = (org: string) => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "my-claude", "repos", `${org.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  private repoLoads = new Map<string, Promise<Repo[]>>();
  private cachedRepos(org: string): Repo[] | null {
    const hit = this.repoCache.get(org);
    if (hit) return hit.repos;
    try {
      const d = JSON.parse(readFileSync(this.repoFile(org), "utf8")) as { at: number; repos: Repo[] };
      this.repoCache.set(org, d);
      return d.repos;
    } catch { return null; }
  }
  private orgRepos(org: string, maxAgeMs = 600_000): Promise<Repo[]> {
    const hit = this.repoCache.get(org) ?? (this.cachedRepos(org), this.repoCache.get(org));
    if (hit && Date.now() - hit.at < maxAgeMs) return Promise.resolve(hit.repos);
    const running = this.repoLoads.get(org);
    if (running) return running;
    const load = this.fetchRepos(org).then((list) => {
      this.repoCache.set(org, { at: Date.now(), repos: list });
      try { mkdirSync(dirname(this.repoFile(org)), { recursive: true }); writeFileSync(this.repoFile(org), JSON.stringify({ at: Date.now(), repos: list })); } catch {}
      return list;
    }).finally(() => this.repoLoads.delete(org));
    this.repoLoads.set(org, load);
    return load;
  }
  private async fetchRepos(org: string): Promise<Repo[]> {
    let repos: (Repo & { archived?: boolean })[] = [];
    if (Bun.which("gh") && (await shOk("gh", ["auth", "status"]))) {
      const out = await sh("gh", ["repo", "list", org, "--limit", "2000", "--json", "name,description,isArchived"], { ok: true });
      try { repos = (JSON.parse(out || "[]") as any[]).map((r) => ({ name: r.name, description: r.description ?? "", archived: r.isArchived })); } catch { repos = []; }
    }
    if (!repos.length) {
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      for (const kind of ["orgs", "users"]) {
        for (let page = 1; page <= 20; page++) {
          const r = await fetch(`https://api.github.com/${kind}/${encodeURIComponent(org)}/repos?per_page=100&page=${page}${kind === "orgs" ? "&type=all" : ""}`,
            { headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }).catch(() => null);
          if (!r?.ok) break;
          const batch = (await r.json()) as any[];
          repos.push(...batch.map((x) => ({ name: x.name, description: x.description ?? "", archived: x.archived })));
          if (batch.length < 100) break;
        }
        if (repos.length) break;
      }
    }
    return repos.filter((r) => !r.archived).map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async projectAdd(name: string): Promise<void> {
    const org = String(config().clone?.defaultOrg ?? "");
    const have = new Set(this.snap(name)?.project.peers.map((x) => x.repo) ?? []);
    const choices = (repos: Repo[]) => {
      const pickable = repos.filter((r) => !have.has(r.name));
      return { enum: pickable.map((r) => r.name), enumRows: pickable.map((r) => [r.name, r.description]) };
    };
    // the dialog at once, with the last list known; the fresh one is filled in when it comes
    const cached = org ? this.cachedRepos(org) : null;
    const id = `ask-${++this.askSeq}`;
    const boxed = this.snap(name)?.project.profile !== "host"; // only a container has ports to forward into
    const answer = this.ask({ title: `Add repos to ${name}`, ok: "Add", schema: { type: "object", order: ["pick", "folder", "spec", "ports"], properties: {
      ...(org ? { pick: { type: "array", format: "picker", title: `${org}'s repos`, columns: ["Repo", "Description"], ...choices(cached ?? []), note: cached ? "refreshing…" : "loading…",
        description: "Tick any number; each is cloned fresh into the project." } } : {}),
      folder: { type: "string", format: "path", title: "A folder here", description: "An existing checkout, used where it is (no clone)." },
      spec: { type: "string", title: "Anything else", placeholder: "org/repo  https://…  git@host:repo  ~/path  (--branch B, --name N after one)", description: "Space separated: other organisations' repos, git URLs, a PR URL, paths." },
      ...(boxed ? { ports: { type: "string", title: "Forward ports", placeholder: "20808  8080:80  0.0.0.0:3000:3000",
        description: "From this machine into each added repo's container: PORT (same both sides), HOST:CONTAINER, or IP:HOST:CONTAINER to listen beyond localhost. Space separated." } } : {}) } } }, id);
    if (org) void this.orgRepos(org, 0).then((repos) => this.send({ op: "fill", id, key: "pick", ...choices(repos), note: "" }),
      (e) => this.send({ op: "fill", id, key: "pick", ...choices(cached ?? []), note: `could not list them: ${errText(e)}` }));
    const v = await answer;
    if (!v) return;
    const line = [...([] as unknown[]).concat(v.pick ?? []).filter(Boolean).map((r) => `${org}/${r}`), ...(v.folder ? [String(v.folder)] : []), ...(v.spec ? [String(v.spec)] : [])].join(" ").trim();
    if (!line) return;
    await this.work(name, `adding to ${name}…`, async () => {
      const ports = String(v.ports ?? "").split(/\s+/).filter(Boolean);
      // its first repos: the project is still being set up
      const first = !load(name).peers.length;
      if (first) { this.settingUp.add(name); this.requestSync(); }
      try {
        const peers = await core.addRepos(name, line, { log: (m) => this.progress(name, `${name}: ${m}`), takeover: true, ports });
        await core.syncGroupNow(name);
        this.notify(`added ${peers.map((p) => p.repo).join(", ")} to ${name}`);
      } finally { if (first) this.settingUp.delete(name); }
    });
  }

  private async projectTicket(name: string): Promise<void> {
    const v = await this.ask({ title: `Ticket for ${name}`, ok: "Set", text: "The tracker ticket this project is for; every peer is told. Empty clears it.", schema: { type: "object", properties: { ticket: { type: "string", title: "Ticket", placeholder: "ABC-123" } } }, values: { ticket: this.snap(name)?.project.ticket ?? "" } });
    if (!v) return;
    await this.work(name, "", async () => { const t = await core.setTicket(name, String(v.ticket ?? "")); this.notify(t ? `${name} is for ${t}` : `${name}: ticket cleared`); });
  }

  private async projectGoal(name: string): Promise<void> {
    const v = await this.ask({ title: `Goal of ${name}`, ok: "Set", schema: { type: "object", properties: { goal: { type: "string", title: "Goal", format: "multiline" } } }, values: { goal: this.snap(name)?.project.goal ?? "" } });
    if (!v) return;
    await this.work(name, "", () => { core.setGoal(name, String(v.goal ?? "")); this.notify(`${name}: goal set (peers read it at their next launch; Brief sends it now)`); });
  }

  private async projectColor(name: string): Promise<void> {
    const v = await this.ask({ title: `Color of ${name}`, ok: "Set", schema: { type: "object", properties: { color: { type: "string", title: "Color", enum: Object.keys(PALETTE) } } }, values: { color: this.snap(name)?.project.color ?? "" } });
    if (!v?.color) return;
    await this.work(name, "", () => core.setColor(name, String(v.color)));
  }

  private async projectReadd(name: string): Promise<void> {
    const r = [...(this.snap(name)?.project.removed ?? [])].reverse();
    if (!r.length) return this.notify(`nothing was removed from ${name}`);
    const v = await this.ask({ title: `Re-add to ${name}`, ok: "Re-add", text: "A removed repo comes back with the same path and the same conversation.", schema: { type: "object", properties: { repo: { type: "string", title: "Repo", format: "table", enum: r.map((x) => x.repo),
      columns: ["Repo", "Folder", "Removed"], sort: [2, "desc"], enumRows: r.map((x) => [x.repo, tilde(x.path), x.when ? stamp(x.when) : ""]) } } } });
    if (!v?.repo) return;
    await this.work(name, `re-adding ${v.repo}…`, async () => { const p = await core.readd(name, String(v.repo), (m) => this.progress(name, m)); await core.syncGroupNow(name); this.notify(`${p.repo} is back in ${name} (same conversation)`); });
  }

  // Deleting asks only when it would lose work nothing else has (a clone's changes, commits,
  // stashes, or a folder that is no repo); otherwise it just goes, off the disk.
  private async projectDelete(name: string): Promise<void> {
    const lost = await this.checking(name, () => core.projectLosses(name));
    const list = lost.map((x) => `• ${x.repo}: ${x.why.join(", ")}`).join("\n");
    if (lost.length && !(await this.confirm(`Delete project ${name}?`, `This deletes work nothing else has:\n${list}\n\nIts clones are deleted from disk; repos linked from elsewhere stay. Undelete brings back its paths and conversations, not their contents.`, "Delete anyway"))) return;
    await this.work(name, `deleting ${name}…`, async () => {
      const { done } = await core.deleteProject(name, true);
      this.notify(`${name} deleted`);
      void done.then((left) => { if (left.length) this.notify(left.join("; "), { alert: true }); });
    });
  }

  // What deleting would lose, with the user told why nothing happens yet (git can take a moment).
  private async checking<T>(name: string, f: () => Promise<T>): Promise<T> {
    this.send({ op: "busy", text: `${name}: checking for unpushed work…` });
    try { return await f(); } finally { this.showBusy(); }
  }

  private async peerRestart(name: string, repo: string): Promise<void> {
    if (!(await this.confirm(`Relaunch ${repo}?`, "Its Claude stops and starts again in the same pane, on the same conversation.", "Relaunch"))) return;
    await this.work(name, `relaunching ${repo}…`, async () => { await core.restart(name, repo); this.notify(`${repo} relaunched`); });
  }

  private async peerLead(name: string, repo: string): Promise<void> {
    const v = await this.ask({ title: `${repo} leads ${name}`, ok: "Set and brief", text: "The lead gets the goal and the roster; every other peer is told who leads and what for.", schema: { type: "object", properties: { goal: { type: "string", title: "Goal", format: "multiline" } } }, values: { goal: this.snap(name)?.project.goal ?? "" } });
    if (!v) return;
    await this.work(name, `briefing ${name}…`, async () => { const notes = await core.setLead(name, repo, String(v.goal ?? "")); this.notify(`${repo} leads ${name}; ${notes.join("; ")}`); });
  }

  private async peerModel(name: string, repo: string): Promise<void> {
    const cur = this.snap(name)?.peers.find((x) => x.repo === repo)?.model ?? "default";
    const v = await this.ask({ title: `Model for ${repo}`, ok: "Set", text: "Takes effect when the peer is relaunched.", schema: { type: "object", properties: { model: { type: "string", title: "Model", enum: MODELS.includes(cur) ? MODELS : [...MODELS, cur] } } }, values: { model: cur } });
    if (!v?.model) return;
    await this.work(name, "", () => { core.setPeer(name, repo, { model: v.model === "default" ? null : String(v.model) }); this.notify(`${repo}: model ${v.model} from its next launch`); });
  }

  private async peerTakeover(name: string, repo: string): Promise<void> {
    if (!(await this.confirm(`Take over ${repo}?`, "A Claude session my-claude did not start is running in that checkout. It is stopped, and the peer launched in its place.", "Take over"))) return;
    await this.work(name, `taking over ${repo}…`, () => core.takeover(name, repo));
  }

  private async peerRemove(name: string, repo: string): Promise<void> {
    const why = await this.checking(repo, () => core.peerLosses(name, repo));
    const ok = why.length
      ? await this.confirm(`Close ${repo}?`, `Its clone is deleted from disk, and with it work nothing else has: ${why.join(", ")}.\n\nRe-add brings it back on the same conversation, cloned afresh.`, "Delete anyway")
      : await this.confirm(`Close ${repo}?`, "Its session ends and its panes close; a clone the project made is deleted from disk. Re-add brings it back on the same conversation.", "Close");
    if (!ok) return;
    await this.work(name, `removing ${repo}…`, async () => {
      const note = await core.rmPeer(name, repo, { force: true, wait: false });
      await core.syncGroupNow(name);
      this.notify(`removed ${repo} from ${name}${note ? "; " + note : ""}`);
    });
  }

  // Ctrl+Shift+X: what prefix+x does. A peer's own pane removes the peer; anything else closes.
  private async paneClose(name: string, t: Target): Promise<void> {
    if (!t.pane) {
      if (t.repo) return this.peerRemove(name, t.repo);
      throw new Error("no pane to close here");
    }
    const at = await core.paneFacts(t.pane);
    if (at.peer) return this.peerRemove(name, at.rawTitle);
    // asks only when something besides its shell runs there; a chat pane is just the chat
    const busy = at.role.startsWith("chat:") ? null : await core.paneBusy(t.pane);
    const why = busy === "?" ? `${at.title} is a shell in a container, opened before my-claude could see what runs there: anything running in it stops.` : `${at.title} is running ${busy}: closing it ends it.`;
    if (busy && !(await this.confirm(`Close ${at.title}?`, why, "Close"))) return;
    await this.work(name, "", async () => { await core.closePane(t.pane!); });
  }
}

export async function drive(): Promise<number> {
  adoptShellEnv(config().shell?.login !== false, log);
  // --stdio: the window is on the other end of stdin/stdout; nothing else may write there
  const stdio = process.argv.includes("--stdio");
  if (stdio) {
    console.log = (...a: unknown[]) => console.error(...a);
    process.env.MY_CLAUDE_REMOTE = "1"; // a window on another machine: native panes only, projects left as they are when it goes
  }
  const sock = stdio ? "-" : process.env.MC_TERM_SOCKET || defaultSocket();
  log(`my-claude gui driver starting (pid ${process.pid})`);
  process.on("uncaughtException", (e) => log(`uncaught: ${e instanceof Error ? e.stack : e}`));
  process.on("unhandledRejection", (e) => log(`unhandled: ${e instanceof Error ? e.stack : e}`));
  try {
    return await new Driver(sock).run();
  } catch (e) {
    log(`driver failed: ${e instanceof Error ? e.stack : e}`);
    return 1;
  }
}
