// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// The user in tests/gui.sh: raises what clicks and keys raise (`emit`), answers dialogs, and
// checks what the window shows and what tmux and the records say.
import { connect } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

function startHost(env: Record<string, string | undefined> = process.env) {
  host = Bun.spawn([bin, "--socket", sock, "--driver", driver], { stdout: "ignore", stderr: "inherit", env });
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
// the projects' panes (the consoles, in their panel, are not a project's)
const titles = (l: any, tab?: string) => l.terminals.filter((t: any) => t.tab !== "_consoles" && (!tab || t.tab === tab)).map((t: any) => t.title).join(",");
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
// a finished turn's mark goes once its terminal is looked at; a question stays until answered
{
  const mark = join(root, "projects", "demo", ".attn", "r1");
  mkdirSync(dirname(mark), { recursive: true });
  writeFileSync(mark, "wait");
  u.send({ op: "emit", event: { ev: "seen", id: r1.id } });
  for (let i = 0; i < 100 && existsSync(mark); i++) await Bun.sleep(50);
  if (existsSync(mark)) fail("a finished turn should be read once its terminal is seen");
  writeFileSync(mark, "ask");
  u.send({ op: "emit", event: { ev: "seen", id: r1.id } });
  await Bun.sleep(1000);
  if (!existsSync(mark)) fail("a question should stay until it is answered");
  rmSync(mark);
}
// an agent's state on its entry: frames while it works, stills when it asks (bold) or is done.
// r2: the keyboard stays in r1, so r2's finished turn is not read the moment it shows.
{
  u.send({ op: "focus", id: r1.id });
  await u.shows("r1 with the keyboard", (x) => x.terminals.find((t: any) => t.id === r1.id)?.active === true);
  const mark = join(root, "projects", "demo", ".attn", "r2");
  const node = (x: any) => x.nodes.find((n: any) => n.id === "r:demo/r2");
  writeFileSync(mark, "work");
  await u.shows("r2 working", (x) => node(x)?.state === "work");
  const icons = new Set<string>();
  for (const t0 = Date.now(); Date.now() - t0 < 1500; await Bun.sleep(40)) icons.add(node(await u.list())?.icon);
  if (icons.size < 3 || ![...icons].every((i) => /^console-working-\d\d$/.test(i))) fail("a working agent's icon should step through its frames", [...icons]);
  writeFileSync(mark, "ask");
  await u.shows("r2 asking: its still, in bold", (x) => node(x)?.state === "ask" && node(x)?.icon === "console-asking" && node(x)?.bold === true);
  writeFileSync(mark, "wait");
  await u.shows("r2 done", (x) => node(x)?.state === "wait" && node(x)?.icon === "console-done" && node(x)?.bold === false);
  rmSync(mark);
  await u.shows("r2 idle", (x) => node(x)?.state === "" && node(x)?.icon === "console");
  // an agent launched before the hooks knew "work": its screen's last line says it is busy
  const r2 = (await u.list()).terminals.find((t: any) => t.title === "r2");
  u.send({ op: "send", id: r2.id, text: "  bypass permissions on · esc to interrupt" });
  await u.shows("r2 busy by its footer", (x) => node(x)?.state === "work");
  u.send({ op: "send", id: r2.id, text: "\rx\rx\rx\r" });
  await u.shows("r2 idle once the footer is gone", (x) => node(x)?.state === "");
}
// Open folder: the repo's, or the project's, in the desktop's file manager (tests only note it)
{
  const press = async (keys: string) => { u.send({ op: "key", keys }); return u.until("keyed", (m: any) => m.keys === keys); };
  const r1path = record("demo").peers.find((x: any) => x.repo === "r1").path;
  u.act("peer.files", { node: "r:demo/r1" });
  await u.shows("r1's folder opened", (x) => x.opened === `file://${r1path}`);
  u.act("project.files", { node: "p:demo" });
  await u.shows("the project's folder opened", (x) => x.opened === `file://${join(root, "projects", "demo")}`);
  // in the list its key is Ctrl+F; a bare f is the list's type-to-find
  u.send({ op: "focus", id: r1.id });
  await u.shows("r1 with the keyboard", (x) => x.terminals.find((t: any) => t.id === r1.id)?.active === true);
  if ((await press("Ctrl+`")).focus !== "QTreeWidget") fail("Ctrl+` should put the keyboard in the project list");
  u.send({ op: "sidebar", select: "r:demo/r1" });
  await u.shows("the list on r1", (x) => x.selected === "r:demo/r1");
  await press("f");
  await Bun.sleep(300);
  if ((await u.list()).opened !== `file://${join(root, "projects", "demo")}`) fail("a bare f should not run Open folder");
  await press("Ctrl+F");
  await u.shows("Ctrl+F in the list opens r1's folder", (x) => x.opened === `file://${r1path}`);
  await press("Ctrl+`");
}
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
await key("Ctrl+Shift+O");
await u.shows("Ctrl+Shift+O moves to the next pane", (x) => x.terminals.find((t: any) => t.title === "r2")?.active === true);
await key("Ctrl+Shift+P");
await u.shows("Ctrl+Shift+P moves back", (x) => term(x, r1.id)?.active === true);
if ((await key("Ctrl+`")).focus !== "QTreeWidget") fail("Ctrl+` should put the keyboard in the project list");
if (!/Konsole|Terminal/.test((await key("Ctrl+`")).focus)) fail("Ctrl+` again should go back to the pane");

// --- consoles: shells on this machine, not a project's, in a panel over the project
const run = (action: string) => u.send({ op: "run", action });
const dock = (x: any) => x.consoles.find((d: any) => d.tab === "_consoles");
const ctabs = (x: any) => (dock(x)?.tabs ?? []).join();
const conTmux = () => tmux("list-windows", "-t", "=my-claude-consoles", "-F", "#{window_name}").split("\n").filter(Boolean).join();
const conOf = (x: any, name: string) => x.terminals.find((t: any) => t.tab === "_consoles" && t.title === name);
const screenOf = async (id: string) => { u.send({ op: "screen", id }); return (await u.until("screen", (m) => m.id === id)).text as string; };
u.send({ op: "focus", id: r1.id });
await key("Ctrl+Shift+N");
l = await u.shows("Ctrl+Shift+N: console1 up over demo, with the keyboard", (x) => ctabs(x) === "console1" && dock(x).visible && conOf(x, "console1")?.active === true);
if (conTmux() !== "console1") fail("console1 should be a window of the consoles' session", conTmux());
if (!l.nodes.some((n: any) => n.id === "c:_consoles" && n.badge === "1")) fail("the list's Consoles entry should count it", l.nodes);
if (titles(l, "demo") !== "r1,r2") fail("a console is no pane of the project", titles(l, "demo"));
const c1 = conOf(l, "console1");
if (native) await u.shows("console1 live", (x) => conOf(x, "console1")?.live === true);
u.send({ op: "send", id: c1.id, text: "echo in-$((6*7))-console\r" });
for (let i = 0; !(await screenOf(c1.id)).includes("in-42-console"); i++) if (i > 60) fail("typing into a console should run in its shell", await screenOf(c1.id)); else await Bun.sleep(100);
await key("Ctrl+Shift+N");
l = await u.shows("console2, in front in the panel", (x) => ctabs(x) === "console1,console2" && dock(x).current === "console2");
const c2 = conOf(l, "console2");
run("host.console-next");
await u.shows("the next console: round to console1", (x) => dock(x).current === "console1");
// renamed: unique by name, a taken one refused (an error to read)
u.send({ op: "emit", event: { ev: "rename", id: c2.id, name: "build" } });
await u.shows("console2 renamed", (x) => ctabs(x) === "console1,build");
if (conTmux() !== "console1,build") fail("the console's tmux window should carry its name", conTmux());
u.send({ op: "emit", event: { ev: "rename", id: c2.id, name: "console1" } });
l = await u.shows("a taken name refused, with an error", (x) => x.asks.length > 0);
u.send({ op: "answer", id: l.asks[0], cancelled: true });
if (conTmux() !== "console1,build") fail("two consoles must never share a name", conTmux());
// the panel: maximised and back, minimised to its title strip and back
u.send({ op: "focus", id: c1.id });
await key("Ctrl+Shift+Z");
await u.shows("maximised", (x) => dock(x).maximised === true);
await key("Ctrl+Shift+Z");
await u.shows("restored", (x) => dock(x).maximised === false);
await key("Ctrl+M");
await u.shows("minimised, still on the view", (x) => dock(x).minimised === true && dock(x).visible);
u.send({ op: "focus", id: c1.id });
await u.shows("back with the keyboard", (x) => dock(x).minimised === false && conOf(x, "console1")?.active === true);
// show/hide: off the view, the consoles live on; back without a new one
run("host.consoles");
await u.shows("the panel off demo", (x) => dock(x).visible === false && dock(x).count === 2);
if (conTmux() !== "console1,build") fail("hiding the panel must not end its consoles", conTmux());
run("host.consoles");
await u.shows("the panel back, no new console", (x) => dock(x).visible && ctabs(x) === "console1,build");
// Ctrl+W in a console closes it (an idle shell: no question); exiting its shell does too
u.send({ op: "focus", id: c2.id });
await key("Ctrl+W");
await u.shows("build closed", (x) => ctabs(x) === "console1");
if (conTmux() !== "console1") fail("closing a console should end it", conTmux());
u.send({ op: "send", id: c1.id, text: "exit\r" });
await u.shows("console1 gone with its shell, the panel with it", (x) => !dock(x) || (dock(x).count === 0 && !dock(x).visible));
await u.shows("the Consoles entry stays, empty", (x) => x.nodes.some((n: any) => n.id === "c:_consoles" && n.badge === ""));
// show/hide with none: one is opened (the list's entry does the same)
run("host.consoles");
await u.shows("show/hide opened console1", (x) => ctabs(x) === "console1" && dock(x).visible);
run("host.consoles");
await u.shows("and hid it", (x) => !dock(x).visible);
u.send({ op: "emit", event: { ev: "activate", node: "c:_consoles" } });
l = await u.shows("the list's entry shows it again, still one", (x) => dock(x).visible && ctabs(x) === "console1");
// (none left for what follows, which counts what the window holds in tmux)
u.send({ op: "send", id: conOf(l, "console1").id, text: "exit\r" });
await u.shows("no consoles", (x) => !dock(x) || dock(x).count === 0);
for (let i = 0; i < 40 && controls().length > 1; i++) await Bun.sleep(100);
u.send({ op: "focus", id: r1.id });

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

// --- add a repo from the sidebar, then remove it: one linked from elsewhere goes at once and stays
// on disk; a clone is deleted, and asks first when it holds work nothing else has (cancel keeps it)
u.act("project.add", { node: "p:demo" });
await u.answer({ spec: join(tmp, "r3") });
l = await u.shows("r3 added", (x) => titles(x) === "r1,r2,r3");
u.act("pane.close", { id: l.terminals.find((t: any) => t.title === "r3").id, focus: "term", tab: "demo" }); // on a peer's pane: removes the peer
await u.shows("r3 removed, nothing asked", (x) => titles(x) === "r1,r2" && x.asks.length === 0);
if (!existsSync(join(tmp, "r3"))) fail("a linked repo must stay on disk");
{
  const git = (...a: string[]) => { if (Bun.spawnSync(["git", ...a]).exitCode !== 0) fail(`git ${a.join(" ")}`); };
  git("init", "-q", "-b", "main", join(tmp, "upstream"));
  git("-C", join(tmp, "upstream"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
  git("clone", "-q", "--bare", join(tmp, "upstream"), join(tmp, "origin.git"));
  u.act("project.add", { node: "p:demo" });
  await u.answer({ spec: "file://" + join(tmp, "origin.git") });
  await u.shows("the clone added", (x) => titles(x) === "r1,r2,origin");
  const clone = join(root, "projects", "demo", "origin");
  writeFileSync(join(clone, "wip"), "x");
  u.act("peer.remove", { node: "r:demo/origin" });
  await u.answer(null);
  await Bun.sleep(500);
  if (!record("demo").peers.some((x: any) => x.repo === "origin") || !existsSync(join(clone, "wip"))) fail("a cancelled removal removed");
  u.act("peer.remove", { node: "r:demo/origin" });
  await u.answer({});
  await u.shows("the clone removed", (x) => titles(x) === "r1,r2");
  for (let i = 0; i < 50 && existsSync(clone); i++) await Bun.sleep(100);
  if (existsSync(clone)) fail("a removed clone should be off the disk");
}
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
await u.answer({ name: "Second One", repos: join(tmp, "r3"), goal: "g", mode: "per-repo", color: "green" });
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
// consoles pinned: over every project; unpinned, back to the one they were opened on
u.send({ op: "tab", tab: "demo", focus: true });
await u.shows("demo in front", (x) => x.current === "demo");
run("host.consoles");
await u.shows("a console over demo", (x) => dock(x)?.visible && dock(x).count === 1);
u.send({ op: "tab", tab: "second-one", focus: true });
await u.shows("second-one in front, the consoles not over it", (x) => x.current === "second-one" && dock(x) && !dock(x).visible);
run("host.console-pin");
await u.shows("pinned: over second-one", (x) => dock(x).visible && dock(x).pinned);
u.send({ op: "tab", tab: "demo", focus: true });
await u.shows("and over demo", (x) => x.current === "demo" && dock(x).visible);
run("host.console-pin");
u.send({ op: "tab", tab: "second-one", focus: true });
await u.shows("unpinned on demo: not over second-one", (x) => x.current === "second-one" && !dock(x).visible && !dock(x).pinned);
u.send({ op: "tab", tab: "demo", focus: true });
l = await u.shows("still over demo", (x) => x.current === "demo" && dock(x).visible);
u.send({ op: "send", id: l.terminals.find((t: any) => t.tab === "_consoles").id, text: "exit\r" });
await u.shows("no consoles", (x) => !dock(x) || dock(x).count === 0);
// a project started behind the window's back (the CLI, an agent) gets its tab too
sh("bun", [join(root, "src/cli.ts"), "new", "third"]); sh("bun", [join(root, "src/cli.ts"), "add", "third", join(tmp, "r4")]); sh("bun", [join(root, "src/cli.ts"), "up", "third", "--no-attach"]);
await u.shows("third appears", (x) => x.tabs.join() === "demo,second-one,third" && titles(x, "third") === "r4");
// bring one down: its tab, its views and its session go
u.act("project.down", { node: "p:second-one" });
await u.answer({});
await u.shows("second-one down", (x) => x.tabs.join() === "demo,third");
if (tmux("list-sessions", "-F", "#{session_name}").includes("second-one")) fail("down left sessions", tmux("list-sessions", "-F", "#{session_name}"));
u.act("project.delete", { node: "p:third" }); // nothing of its would be lost: nothing to ask
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

// --- the toolbar: a button greyed when what is highlighted is not for it
{
  const on = (x: any, id: string) => x.toolbar?.find((t: any) => t.id === id)?.enabled;
  u.send({ op: "sidebar", select: "p:demo" }); // a running project, the list has the keyboard
  await u.shows("Stop on for a running project, Start off", (x) => on(x, "project.down") === true && on(x, "project.open") === false && on(x, "app.new") === true);
  u.send({ op: "sidebar", select: "r:demo/r1" });
  await u.shows("a running repo: the container shell on", (x) => on(x, "pane.shell") === true);
  u.send({ op: "sidebar" }); // the list takes the keyboard: its entry is what counts
  u.send({ op: "sidebar", select: "p:third" }); // stopped (undeleted above)
  await u.shows("a stopped project: Start on, Stop and the shells off", (x) => on(x, "project.open") === true && on(x, "project.down") === false && on(x, "pane.shell") === false);
  u.send({ op: "sidebar" }); // and back to the pane
}

// --- the overview: every terminal at once (its key), gone again with Esc
await key("Meta+Shift+W");
await u.shows("the overview open", (x) => x.overview === true);
await key("Escape");
await u.shows("the overview closed", (x) => x.overview === false);

// --- the shortcuts: a table. A key another action has is asked about (and that one turned
// off); one the desktop holds is refused; Esc clears.
run("host.settings");
await u.shows("Settings open", (x) => x.asks.includes("settings"));
{
  const kt = async (o: object) => { u.send({ op: "keytable", row: "", ...o }); return u.until("keytable"); };
  const row = (k: any, id: string) => k.rows.find((r: any) => r.id === id);
  const answerModal = async (button: string) => { u.send({ op: "modal", button }); await u.until("modal"); };
  let k = await kt({ row: "host.pane-prev", keys: "Ctrl+Shift+O" });
  if (!/Next pane/.test(k.modal)) fail("a key another action has should be asked about", k);
  await answerModal("Give it");
  k = await kt({});
  if (row(k, "host.pane-prev").custom !== "Ctrl+Shift+O" || row(k, "host.pane-next").enabled !== false) fail("given: the key moves, the other action is off", [row(k, "host.pane-prev"), row(k, "host.pane-next")]);
  k = await kt({ row: "host.pane-next", enabled: true });
  if (!/Previous pane/.test(k.modal)) fail("turning on an action whose key is taken should ask", k);
  await answerModal("Cancel");
  k = await kt({});
  if (row(k, "host.pane-next").enabled !== false) fail("cancelled: it stays off", row(k, "host.pane-next"));
  k = await kt({ row: "host.overview", keys: "Alt+F1" });
  if (!/Plasma/.test(k.modal) || row(k, "host.overview").custom !== "") fail("a key the desktop holds should be refused", k);
  await answerModal("OK");
  k = await kt({ row: "host.pane-prev", keys: "Escape" });
  if (row(k, "host.pane-prev").custom !== "") fail("Esc should clear the key", row(k, "host.pane-prev"));
  k = await kt({ row: "host.consoles", keys: "Ctrl+Alt+K" });
  if (k.modal || row(k, "host.consoles").custom !== "Ctrl+Alt+K") fail("a free key is just taken", k);
  await kt({ accept: true });
}
{
  const sf = join(process.env.HOME!, ".config", "my-claude", "settings.json");
  let g: any = {};
  for (let i = 0; i < 60 && !((g = JSON.parse(readFileSync(sf, "utf8")).gui ?? {}).keys?.["host.consoles"]); i++) await Bun.sleep(100);
  if (JSON.stringify(g.keys?.["host.consoles"]) !== '["Ctrl+Alt+K"]' || !g.keysOff?.includes("host.pane-next") || g.keys?.["host.pane-prev"]) fail("the table saved as keys and keysOff", { keys: g.keys, keysOff: g.keysOff });
  await u.shows("the new key in the menus", (x) => x.actions.includes("host.consoles"));
  const before = dock(await u.list()).visible;
  // (a press before the new menus arrive does nothing, so pressing again is safe)
  for (let i = 0; ; i++) {
    await key("Ctrl+Alt+K");
    if (dock(await u.list()).visible !== before) break;
    if (i > 30) fail("Ctrl+Alt+K should show/hide the consoles now");
    await Bun.sleep(200);
  }
  // (it opened one: gone again for what follows)
  for (const t of (await u.list()).terminals.filter((t: any) => t.tab === "_consoles")) u.send({ op: "send", id: t.id, text: "exit\r" });
  await u.shows("no consoles", (x) => !dock(x) || dock(x).count === 0);
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

// --- a window that keeps its state (in this test's HOME) opens where the user left it: the
// pane zoomed, the consoles' panel up, the keyboard in the console it was in
{
  const { MC_TERM_NO_STATE: _off, ...kept } = process.env;
  startHost(kept);
  u = await client();
  l = await u.shows("demo, keeping state", (x) => titles(x) === "r1,r2 ★" && (!native || x.terminals.filter((t: any) => t.tab !== "_consoles").every((t: any) => t.live)));
  const r2 = l.terminals.find((t: any) => t.title.startsWith("r2"));
  u.send({ op: "focus", id: r2.id });
  u.send({ op: "zoom", id: r2.id, on: true });
  u.send({ op: "run", action: "host.consoles" });
  l = await u.shows("r2 zoomed, a console up with the keyboard", (x) => term(x, r2.id)?.zoomed === true && dock(x)?.visible && x.terminals.some((t: any) => t.tab === "_consoles" && t.active));
  const con = l.terminals.find((t: any) => t.tab === "_consoles");
  await Bun.sleep(2000); // kept 1.5 s after the last change, and at the quit
  u.send({ op: "quit" });
  await host!.exited;
  startHost(kept);
  u = await client();
  await u.shows("as it was: r2 zoomed, the consoles over demo, the keyboard in the console",
    (x) => x.current === "demo" && term(x, r2.id)?.zoomed === true && dock(x)?.visible === true && term(x, con.id)?.active === true, 20000);
  u.send({ op: "send", id: con.id, text: "exit\r" });
  await u.shows("no consoles", (x) => !dock(x) || dock(x).count === 0);
  // a working agent's frames step while the window is out of sight too: on Wayland it never
  // learns it is back on screen (last: offscreen, a hidden window does not come back active)
  {
    const mark = join(root, "projects", "demo", ".attn", "r2");
    const node = (x: any) => x.nodes.find((n: any) => n.id === "r:demo/r2");
    writeFileSync(mark, "work");
    await u.shows("r2 working", (x) => node(x)?.state === "work");
    u.send({ op: "toggle" });
    await u.shows("the window hidden", (x) => x.shown === false);
    const unseen = new Set<string>();
    for (const t0 = Date.now(); Date.now() - t0 < 1000; await Bun.sleep(40)) unseen.add(node(await u.list())?.icon);
    if (unseen.size < 3) fail("frames should step while the window is hidden", [...unseen]);
    rmSync(mark);
  }
  u.send({ op: "quit" });
  await host!.exited;
}
console.log("gui e2e OK");
process.exit(0);
