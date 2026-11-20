// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// The user in tests/gui.sh: raises what clicks and keys raise (`emit`), answers dialogs, and
// checks what the window shows and what tmux and the records say.
import { connect } from "node:net";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const tmp = process.env.E2E_TMP!, bin = process.env.E2E_BIN!, driver = process.env.E2E_DRIVER!;
const root = process.env.MY_CLAUDE_ROOT!;
const sock = join(tmp, "host.sock");
const sh = (cmd: string, args: string[]) => Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
const tmux = (...args: string[]) => sh("tmux", args);
const record = (name: string) => JSON.parse(readFileSync(join(root, "projects", name, "project.json"), "utf8"));
let host: ReturnType<typeof Bun.spawn> | null = null;
const fail = (m: string, extra?: unknown): never => {
  console.error("FAIL:", m, extra === undefined ? "" : "\n" + JSON.stringify(extra, null, 1));
  console.error("tmux sessions:", tmux("list-sessions", "-F", "#{session_name} attached=#{session_attached} group=#{session_group}"));
  if (host) {
    console.error(`window: pid ${host.pid} exitCode=${host.exitCode} signal=${host.signalCode}`);
    // A window that stopped answering: where is it stuck?
    if (host.exitCode === null && process.env.E2E_STACK) console.error(sh("gdb", ["-p", String(host.pid), "-batch", "-ex", "bt 25"]).split("\n").filter((x) => x.startsWith("#")).join("\n"));
  }
  host?.kill();
  process.exit(1);
};
setTimeout(() => fail("timeout"), 170_000);

function startHost() {
  host = Bun.spawn([bin, "--socket", sock, "--driver", driver], { stdout: "ignore", stderr: "inherit" });
  Bun.write(join(tmp, `host.pid.${host.pid}`), String(host.pid));
  return host;
}
async function client() {
  for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(50);
  let c!: ReturnType<typeof connect>;
  for (let i = 0; ; i++) {
    try { c = connect(sock); await new Promise((r, j) => { c.on("connect", r); c.on("error", j); }); break; } catch (e) { if (i > 60) throw e; await Bun.sleep(100); }
  }
  const got: any[] = [];
  let buf = "";
  c.on("data", (d) => { buf += d; for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
  const send = (o: object) => c.write(JSON.stringify(o) + "\n");
  const until = async (ev: string, pred: (m: any) => boolean = () => true, what = ev, tries = 500) => {
    for (let i = 0; i < tries; i++) {
      const k = got.findIndex((x) => x.ev === ev && pred(x));
      if (k >= 0) return got.splice(k, 1)[0];
      await Bun.sleep(20);
    }
    return fail(`no ${what}`, got.slice(-6));
  };
  const list = async () => { send({ op: "list" }); return until("list"); };
  // Poll the window until it looks a certain way.
  const shows = async (what: string, pred: (l: any) => boolean, ms = 15000) => {
    let l: any;
    for (const t0 = Date.now(); Date.now() - t0 < ms; ) { l = await list(); if (pred(l)) return l; await Bun.sleep(150); }
    return fail(`window never showed: ${what}`, { terminals: l.terminals, tabs: l.tabs, asks: l.asks, nodes: l.nodes });
  };
  const act = (action: string, o: object = {}) => send({ op: "emit", event: { ev: "action", action, ...o } });
  // Answer the dialog an action opens.
  const answer = async (values: object | null) => {
    const l = await shows("a dialog", (x) => x.asks.length > 0);
    send(values === null ? { op: "answer", id: l.asks[0], cancelled: true } : { op: "answer", id: l.asks[0], values });
    await shows("the dialog to close", (x) => !x.asks.includes(l.asks[0]));
  };
  return { c, got, send, until, list, shows, act, answer };
}
const titles = (l: any, tab?: string) => l.terminals.filter((t: any) => !tab || t.tab === tab).map((t: any) => t.title).join(",");
// How the window shows a pane: as its terminal through a tmux control client (native), or
// as a tmux client of its own drawing it (a "view" session per pane).
const native = process.env.E2E_PANES !== "view";
const views = () => tmux("list-sessions", "-F", "#{session_name} #{session_attached}").split("\n").filter((s) => s.startsWith("mcv-"));
const controls = () => tmux("list-clients", "-F", "#{client_control_mode} #{session_name} #{client_name}").split("\n").filter((s) => s.startsWith("1 "));
// What the window holds on to in tmux, either way.
const attached = () => (native ? controls() : views());

// --- the window opens on the running project: a tab, a pane per peer, the solo layout underneath
startHost();
let u = await client();
await u.until("hello");
let l = await u.shows("demo with r1 and r2", (x) => titles(x) === "r1,r2" && x.tabs.join() === "demo");
if (!l.nodes.some((n: any) => n.id === "p:demo") || !l.nodes.some((n: any) => n.id === "r:demo/r2")) fail("sidebar entries", l.nodes);
if (!["app.new", "pane.shell", "host.tab-next", "host.pane-next", "pane.close"].every((a) => l.actions.includes(a))) fail("menu actions", l.actions);
if (record("demo").layout !== "solo") fail("project should be recorded solo");
if (tmux("list-windows", "-t", "=mc-demo", "-F", "#{window_panes}").split("\n").join() !== "1,1") fail("solo: one pane per window");
if (tmux("list-panes", "-s", "-t", "=mc-demo", "-F", "#{pane_title}").includes("my-claude-panel")) fail("solo keeps no panel");
if (native) {
  l = await u.shows("both panes live", (x) => x.terminals.length === 2 && x.terminals.every((t: any) => t.native && t.live));
  if (controls().length !== 1 || !controls()[0].startsWith("1 mc-demo ") || views().length) fail("one control client on the project's session, no view sessions", { controls: controls(), views: views() });
  // each tmux window has the size of the terminal that shows it
  for (const t of l.terminals) {
    const pane = t.id.split("/")[1];
    for (let i = 0; i < 40 && tmux("display-message", "-p", "-t", pane, "#{pane_width}x#{pane_height}") !== `${t.cols}x${t.rows}`; i++) await Bun.sleep(50);
    const size = tmux("display-message", "-p", "-t", pane, "#{pane_width}x#{pane_height}");
    if (size !== `${t.cols}x${t.rows}`) fail("a pane should have its terminal's size", { pane, tmux: size, terminal: `${t.cols}x${t.rows}` });
  }
  if (tmux("display-message", "-p", "-t", l.terminals[0].id.split("/")[1], "#{history_limit}") !== "50000") fail("panes should carry the bounded tmux history");
} else {
  for (let i = 0; i < 40 && views().length < 2; i++) await Bun.sleep(100);
  if (views().length !== 2 || !views().every((v) => v.endsWith(" 1"))) fail("one attached view per pane", views());
}
const r1 = l.terminals.find((t: any) => t.title === "r1");
if (r1.node !== "r:demo/r1") fail("pane should point at its sidebar entry", r1);
// what is typed reaches the pane's program (here: the tty echoes it), and shows
u.send({ op: "send", id: r1.id, text: "typed-in-r1" });
for (let i = 0; ; i++) {
  u.send({ op: "screen", id: r1.id });
  const sc = await u.until("screen", (m) => m.id === r1.id);
  if (sc.text.includes("typed-in-r1")) break;
  if (i > 50) fail("typing should show in the pane", sc.text);
  await Bun.sleep(100);
}

// --- the keys: today's, with no Ctrl-b in front, pressed while a terminal has the keyboard.
// They go through the window system's shortcut handling, where the terminal gets first say.
const key = async (keys: string) => { u.send({ op: "key", keys }); return u.until("keyed", (m) => m.keys === keys); };
const term = (x: any, id: string) => x.terminals.find((t: any) => t.id === id);
u.send({ op: "focus", id: r1.id });
await u.shows("r1 with the keyboard", (x) => term(x, r1.id)?.active === true);
const where = await key("Ctrl+Shift+Z");
if (!/Konsole|Terminal/.test(where.focus)) fail("the key should have been pressed inside a terminal", where);
await u.shows("Ctrl+Shift+Z zooms", (x) => term(x, r1.id)?.zoomed === true);
await key("Ctrl+Shift+Z");
await u.shows("and unzooms", (x) => term(x, r1.id)?.zoomed === false);
await key("Ctrl+M");
await u.shows("Ctrl+M minimises", (x) => term(x, r1.id)?.minimised === true);
u.send({ op: "minimise", id: r1.id, on: false });
await u.shows("restored and focused", (x) => term(x, r1.id)?.minimised === false && term(x, r1.id)?.active === true);
await key("Ctrl+Shift+N");
await u.shows("Ctrl+Shift+N moves to the next pane", (x) => x.terminals.find((t: any) => t.title === "r2")?.active === true);
await key("Ctrl+Shift+P");
await u.shows("Ctrl+Shift+P moves back", (x) => term(x, r1.id)?.active === true);
if ((await key("Ctrl+`")).focus !== "QTreeWidget") fail("Ctrl+` should put the keyboard in the project list");
if (!/Konsole|Terminal/.test((await key("Ctrl+`")).focus)) fail("Ctrl+` again should go back to the pane");

// --- Ctrl+Shift+H on r1: a shell, as a pane of its own, focused
await key("Ctrl+Shift+H");
l = await u.shows("a shell pane", (x) => titles(x) === "r1,r2,shell:r1");
const shell = l.terminals.find((t: any) => t.title === "shell:r1");
await u.shows("the shell focused", (x) => x.terminals.find((t: any) => t.id === shell.id)?.active === true);
// in the sidebar under r1, as a shell (an icon says host or container; no repo in the label)
await u.shows("the shell in the sidebar", (x) => x.nodes.some((n: any) => n.id === `t:demo/${shell.id.split("/").pop()}` || (n.id.startsWith("t:demo/") && /shell$/.test(n.label))));
// --- Ctrl+Shift+X on it: asks, then only the shell goes
await key("Ctrl+Shift+X");
await u.answer({});
await u.shows("the shell gone", (x) => titles(x) === "r1,r2");
if (record("demo").peers.length !== 2) fail("closing a shell must not remove a peer");

// --- add a repo from the sidebar, then remove it again (cancel first)
u.act("project.add", { node: "p:demo" });
await u.answer({ spec: join(tmp, "r3") });
l = await u.shows("r3 added", (x) => titles(x) === "r1,r2,r3");
u.act("peer.remove", { node: "r:demo/r3" });
await u.answer(null);
await Bun.sleep(500);
if (record("demo").peers.length !== 3) fail("a cancelled removal removed");
u.act("pane.close", { id: l.terminals.find((t: any) => t.title === "r3").id, focus: "term", tab: "demo" }); // on a peer's pane: removes the peer
await u.answer({});
await u.shows("r3 removed", (x) => titles(x) === "r1,r2");
if (record("demo").peers.length !== 2 || record("demo").removed?.[0]?.repo !== "r3") fail("removal not recorded", record("demo"));
u.act("project.ticket", { node: "p:demo" });
await u.answer({ ticket: "abc-5" });
for (let i = 0; i < 40 && record("demo").ticket !== "ABC-5"; i++) await Bun.sleep(100);
if (record("demo").ticket !== "ABC-5") fail("ticket not set");
// lead: the pane's title carries the star
u.act("peer.lead", { node: "r:demo/r2" });
await u.answer({ goal: "ship" });
await u.shows("r2 marked lead", (x) => titles(x) === "r1,r2 ★");

// --- an error is shown, not swallowed: a bad repo spec
u.act("project.add", { node: "p:demo" });
await u.answer({ spec: join(tmp, "does-not-exist") + "/" });
l = await u.shows("an error dialog", (x) => x.asks.length > 0);
u.send({ op: "answer", id: l.asks[0], cancelled: true });

// --- what the window holds on to in tmux goes away under it (a view detached with
// prefix+d, the control client thrown out): the panes come back by themselves
const before = l.terminals.map((t: any) => t.id).join();
if (native) {
  // the window's own client is thrown out: its terminals stay, scrollback and all, and a
  // new client takes over
  const was = controls()[0].split(" ")[2];
  tmux("detach-client", "-t", was);
  await u.until("reattached", (m) => m.session === "mc-demo", "the window attached again");
  if (controls().some((c) => c.split(" ")[2] === was)) fail("the old control client should be gone", controls());
} else {
  tmux("kill-session", "-t", `=${views()[0].split(" ")[0]}`);
  const gone = await u.until("exited");
  await u.until("opened", (m) => m.id === gone.id, "the pane reopened");
}
await u.shows("the panes back in their places", (x) => x.terminals.map((t: any) => t.id).join() === before && (!native || x.terminals.every((t: any) => t.live)));
if (native) {
  // and it still shows what was typed before
  u.send({ op: "screen", id: r1.id });
  const sc = await u.until("screen", (m) => m.id === r1.id);
  if (!sc.text.includes("typed-in-r1")) fail("the pane should show what it showed before the client was lost", sc.text);
}
for (let i = 0; i < 40 && attached().length < (native ? 1 : 2); i++) await Bun.sleep(100);
if (attached().length !== (native ? 1 : 2)) fail("not reattached", attached());

// --- the driver dies: the window keeps its terminals, brings it back, and it works again
// Not the window: its own command line carries the driver's as an argument.
const drv = sh("pgrep", ["-f", `${root}/src/cli.ts _gui`]).split("\n").filter((pid) => pid && Number(pid) !== host!.pid && sh("cat", [`/proc/${pid}/comm`]) !== "mc-term");
if (!drv.length) fail("no driver process");
for (const pid of drv) process.kill(Number(pid), "SIGKILL");
await Bun.sleep(300);
l = await u.list();
if (l.terminals.map((t: any) => t.id).join() !== before) fail("terminals must survive the driver", l.terminals);
u.act("project.ticket", { node: "p:demo" });
await u.answer({ ticket: "" });
for (let i = 0; i < 60 && record("demo").ticket; i++) await Bun.sleep(100);
if (record("demo").ticket) fail("the restarted driver did not act");
l = await u.list();
if (l.terminals.map((t: any) => t.id).join() !== before) fail("the restarted driver reopened what was there", l.terminals);

// --- closing a tab hides the project, nothing more; activating its entry brings it back
u.send({ op: "emit", event: { ev: "tab-close", tab: "demo" } });
await u.shows("no tab", (x) => x.tabs.length === 0 && x.terminals.length === 0);
for (let i = 0; i < 40 && attached().length; i++) await Bun.sleep(100);
if (attached().length) fail("nothing should stay attached behind a closed tab", attached());
const paneTitles = () => tmux("list-panes", "-s", "-t", "=mc-demo", "-F", "#{pane_title}").split("\n").sort().join();
// ...and is handed back to the terminal UI as it was: one tiled window, the side panel
for (let i = 0; i < 60 && paneTitles() !== "my-claude-panel,r1,r2"; i++) await Bun.sleep(100);
if (paneTitles() !== "my-claude-panel,r1,r2" || record("demo").layout) fail("a project without a tab should be back in the grid layout, still running", { panes: paneTitles(), layout: record("demo").layout });
u.send({ op: "emit", event: { ev: "activate", node: "p:demo" } });
await u.shows("demo back", (x) => titles(x) === "r1,r2 ★");

// --- a new project from the dialog: created, repos added, started, shown
u.act("app.new");
await u.answer({ name: "Second One", repos: join(tmp, "r3"), goal: "g", ticket: "", mode: "per-repo", color: "green" });
l = await u.shows("second-one with r3", (x) => titles(x, "second-one") === "r3" && x.tabs.join() === "demo,second-one", 30000);
const cur = l.current;
u.send({ op: "focus", id: l.terminals.find((t: any) => t.tab === cur).id });
await key("Ctrl+Tab");
await u.shows("Ctrl+Tab goes to the next project", (x) => x.current !== cur);
// Ctrl+Shift+Tab is the next pane inside the project, not a project
const here = (x: any) => x.terminals.find((t: any) => t.active)?.id;
const first = here(await u.shows("a pane has the keyboard", (x) => x.current !== cur && !!here(x)));
await key("Ctrl+Shift+Tab");
await u.shows("Ctrl+Shift+Tab goes to the project's next pane", (x) => x.current !== cur && !!here(x) && here(x) !== first);
await key("Ctrl+Tab");
await u.shows("Ctrl+Tab comes round to the first project", (x) => x.current === cur);
if (record("second-one").peers[0].repo !== "r3" || record("second-one").color !== "green") fail("new project record", record("second-one"));
// a project started behind the window's back (the CLI, an agent) gets its tab too
sh("bun", [join(root, "src/cli.ts"), "new", "third"]); sh("bun", [join(root, "src/cli.ts"), "add", "third", join(tmp, "r4")]); sh("bun", [join(root, "src/cli.ts"), "up", "third", "--no-attach"]);
await u.shows("third appears", (x) => x.tabs.join() === "demo,second-one,third" && titles(x, "third") === "r4");
// bring one down: its tab, its views and its session go
u.act("project.down", { node: "p:second-one" });
await u.answer({});
await u.shows("second-one down", (x) => x.tabs.join() === "demo,third");
if (tmux("list-sessions", "-F", "#{session_name}").includes("second-one")) fail("down left sessions", tmux("list-sessions", "-F", "#{session_name}"));
u.act("project.delete", { node: "p:third" });
await u.answer({});
await u.shows("third deleted", (x) => x.tabs.join() === "demo" && !x.nodes.some((n: any) => n.id === "p:third"));
// and Undelete brings it back (its choices are "<machine>|<trash dir>", "." being this one)
u.act("app.undelete");
{
  const dir = readdirSync(join(root, ".trash")).find((d) => d.endsWith("-third"));
  if (!dir) fail("third should be in the trash", readdirSync(join(root, ".trash")));
  await u.answer({ which: `.|${dir}` });
}
await u.shows("third undeleted", (x) => x.nodes.some((n: any) => n.id === "p:third"), 20000);

// --- a repo whose conversation is open in a Claude started by hand: starting the project
// asks to take it over, and taking over moves it into the window
const stranger = Bun.spawn([process.env.MY_CLAUDE_CLAUDE!], { cwd: join(tmp, "r5"), stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, FAKE_CLAUDE_LOG: join(tmp, "stranger.log") } });
sh("bun", [join(root, "src/cli.ts"), "new", "held"]); sh("bun", [join(root, "src/cli.ts"), "add", "held", join(tmp, "r5")]);
await u.shows("held in the list", (x) => x.nodes.some((n: any) => n.id === "p:held"));
u.send({ op: "emit", event: { ev: "activate", node: "p:held" } });
await u.shows("the take-over question", (x) => x.asks.length > 0);
await u.answer({});
await u.shows("held taken over, in the window", (x) => titles(x, "held") === "r5", 30000);
for (let i = 0; i < 50 && stranger.exitCode === null && stranger.signalCode === null; i++) await Bun.sleep(100);
if (stranger.exitCode === null && stranger.signalCode === null) { stranger.kill(); fail("taking over should have ended the session started by hand"); }
// adding a repo whose conversation is open elsewhere takes it over without asking
const stranger2 = Bun.spawn([process.env.MY_CLAUDE_CLAUDE!], { cwd: join(tmp, "r6"), stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, FAKE_CLAUDE_LOG: join(tmp, "stranger.log") } });
await Bun.sleep(300);
u.act("project.add", { node: "p:held" });
await u.answer({ spec: join(tmp, "r6") });
await u.shows("r6 added and taken over", (x) => titles(x, "held") === "r5,r6", 30000);
for (let i = 0; i < 50 && stranger2.exitCode === null && stranger2.signalCode === null; i++) await Bun.sleep(100);
if (stranger2.exitCode === null && stranger2.signalCode === null) { stranger2.kill(); fail("adding a repo should take over the session holding it"); }
u.act("project.delete", { node: "p:held" });
await u.answer({});
await u.shows("held deleted", (x) => !x.nodes.some((n: any) => n.id === "p:held"));

// --- the shortcut bar (F1, or Alt held): every key of what has the focus
await key("F1");
{
  const l2 = await u.shows("the shortcut bar", (x) => x.keyBar === true);
  for (const want of ["Ctrl+Tab", "Ctrl+W", "Ctrl+Shift+C", "Next project"]) if (!l2.keyBarText.includes(want)) fail(`the shortcut bar should list ${want}`, l2.keyBarText);
}
await key("F1");
await u.shows("the shortcut bar gone", (x) => x.keyBar === false, 5000);
// held: a tag on each pane, the tab bar and the list while F1 is down, gone when let go
u.send({ op: "key", keys: "F1", hold: 900 });
{
  const h = await u.until("held");
  if (h.badges < 3) fail("holding F1 should tag the tabs, the list and each pane", h);
  await u.shows("the tags gone after F1 is let go", (x) => x.badges === 0, 3000);
}

// --- the menu bar can stay hidden; Alt held brings it up, and it goes again after
u.send({ op: "look", menuPersist: false });
await u.shows("the menu bar hidden", (x) => x.menuBar === false, 3000);
u.send({ op: "key", keys: "Alt", hold: 700 });
{ const h = await u.until("held"); if (!h.menuBar) fail("holding Alt should show the hidden menu bar", h); }
await u.shows("the menu bar hidden again a few seconds after Alt", (x) => x.menuBar === false, 8000);
u.send({ op: "look", menuPersist: true });
await u.shows("the menu bar back for good", (x) => x.menuBar === true, 3000);

// --- a pane's own colour scheme: chosen in its menu, kept, given back when it opens again
{
  const t0 = (await u.list()).terminals.find((t: any) => t.title.startsWith("r1"));
  u.send({ op: "emit", event: { ev: "pane-scheme", id: t0.id, node: t0.node, scheme: "Solarized" } });
  await u.shows("r1 in Solarized", (x) => x.terminals.find((t: any) => t.id === t0.id)?.scheme === "Solarized", 15000);
  // its text size too; both reach the disk 5 seconds after the last change
  u.send({ op: "emit", event: { ev: "pane-text", id: t0.id, step: 3 } });
  const sf = join(process.env.HOME!, ".config", "my-claude", "settings.json");
  const read = () => { try { return JSON.parse(readFileSync(sf, "utf8")); } catch { return {}; } };
  await Bun.sleep(2000);
  if (read().gui?.paneText?.["demo/r1"] === 3) fail("saved too soon: it should wait 5 seconds after the last change");
  let kept: any = {};
  for (let i = 0; i < 80 && !((kept = read()).gui?.paneText?.["demo/r1"] === 3); i++) await Bun.sleep(100);
  if (kept.gui?.paneSchemes?.["demo/r1"] !== "Solarized" || kept.gui?.paneText?.["demo/r1"] !== 3) fail("the pane's scheme and text size should be kept in settings.json", kept.gui);
}

// --- renaming in the list (what F2 sends): a display name; emptied, the default again
u.send({ op: "emit", event: { ev: "rename", node: "p:demo", name: "Demo One" } });
await u.shows("the project renamed", (x) => x.nodes.some((n: any) => n.id === "p:demo" && n.label === "Demo One"));
u.send({ op: "emit", event: { ev: "rename", node: "p:demo", name: "" } });
await u.shows("its own name back", (x) => x.nodes.some((n: any) => n.id === "p:demo" && n.label === "demo"));
u.send({ op: "emit", event: { ev: "rename", node: "r:demo/r2", name: "the web one" } });
await u.shows("the peer renamed", (x) => x.nodes.some((n: any) => n.id === "r:demo/r2" && n.label.startsWith("the web one")));
if (record("demo").peers.find((x: any) => x.repo === "r2")?.label !== "the web one") fail("the peer's display name should be in its record", record("demo").peers);

// --- settings are settings.json, merged
u.send({ op: "emit", event: { ev: "settings", values: { general: { profile: "host", defaultOrg: "acme", chatName: "", peersCli: "/nonexistent/claude-peers-cli", panesPerWindow: 6, panel: true }, window: { font: "", fontSize: 0, scheme: "", openOnStart: true } } } });
const cfgFile = join(process.env.HOME!, ".config", "my-claude", "settings.json");
// (the file may exist already: wait for the save itself)
for (let i = 0; i < 40 && !(existsSync(cfgFile) && readFileSync(cfgFile, "utf8").includes('"acme"')); i++) await Bun.sleep(100);
const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
if (cfg.clone?.defaultOrg !== "acme" || cfg.profile !== "host" || cfg.peers?.cli !== "/nonexistent/claude-peers-cli" || "chat" in cfg && cfg.chat.name) fail("settings not merged into settings.json", cfg);

// --- the window closes: everything keeps running; it opens again on the same panes
u.send({ op: "quit" });
if ((await host!.exited) !== 0) fail("window exit code");
for (let i = 0; i < 40 && attached().length; i++) await Bun.sleep(100);
if (attached().length) fail("nothing should stay attached once the window is gone", attached());
for (let i = 0; i < 80 && paneTitles() !== "my-claude-panel,r1,r2"; i++) await Bun.sleep(100);
if (paneTitles() !== "my-claude-panel,r1,r2") fail("the project must outlive the window, back in the grid layout", paneTitles());
startHost();
u = await client();
await u.shows("demo again after a restart", (x) => titles(x) === "r1,r2 ★" && x.tabs.join() === "demo");
u.send({ op: "quit" });
await host!.exited;
console.log("gui e2e OK");
process.exit(0);
