// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Protocol smoke for mc-term, offscreen: every request and event in PROTOCOL.md, the
// one-window-per-socket rule, and the driver being brought back when it dies.
// Run: bun host/tests/smoke.ts [path-to-mc-term]
import { connect } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] ?? new URL("../build/mc-term", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "mc-term-smoke-"));
const env = { ...process.env, QT_QPA_PLATFORM: "offscreen", MC_TERM_NO_STATE: "1" };
const procs: ReturnType<typeof Bun.spawn>[] = [];
const fail = (m: string, extra?: unknown): never => {
  console.error("FAIL:", m, extra === undefined ? "" : "\n" + JSON.stringify(extra, null, 1));
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};
const timer = setTimeout(() => fail("timeout"), 60000);

function start(sock: string, args: string[] = []) {
  const p = Bun.spawn([bin, "--socket", sock, ...args], { env, stdout: "ignore", stderr: "inherit" });
  procs.push(p);
  return p;
}
async function client(sock: string) {
  for (let i = 0; i < 80 && !existsSync(sock); i++) await Bun.sleep(50);
  const c = connect(sock);
  const got: any[] = [];
  let buf = "";
  c.on("data", (d) => { buf += d; for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
  await new Promise((r, j) => { c.on("connect", r); c.on("error", j); });
  const send = (o: object) => c.write(JSON.stringify(o) + "\n");
  // The first matching event not yet consumed; consumed so a later wait sees a later one.
  const until = async (ev: string, pred: (m: any) => boolean = () => true, what = ev) => {
    for (let i = 0; i < 400; i++) {
      const k = got.findIndex((x) => x.ev === ev && pred(x));
      if (k >= 0) return got.splice(k, 1)[0];
      await Bun.sleep(20);
    }
    return fail(`no ${what}`, got.slice(-8));
  };
  const list = async () => { send({ op: "list" }); return until("list"); };
  return { c, got, send, until, list };
}
const ids = (l: any) => l.terminals.map((t: any) => t.id).join(",");

// --- one host, the whole protocol
const sock = join(dir, "a.sock");
const host = start(sock);
const a = await client(sock);
const hello = await a.until("hello");
if (hello.version !== 2) fail("protocol version", hello);
a.send({ op: "ping" }); await a.until("pong");

a.send({ op: "open", id: "p/a", title: "a", color: "#5fafff", argv: ["sh", "-c", "sleep 0.6"], cwd: "/tmp" });
a.send({ op: "open", id: "p/b", title: "b", node: "r:p/b", argv: ["sleep", "60"] });
a.send({ op: "open", id: "p/c", title: "c", argv: ["sleep", "60"] });
for (const id of ["p/a", "p/b", "p/c"]) await a.until("opened", (m) => m.id === id);
let l = await a.list();
if (ids(l) !== "p/a,p/b,p/c" || l.tabs.join() !== "p" || l.current !== "p") fail("list after open", l);
a.send({ op: "order", tab: "p", ids: ["p/c", "p/a"] });
l = await a.list();
if (ids(l) !== "p/c,p/a,p/b") fail("order", l);

// a process that ends takes its terminal with it
await a.until("exited", (m) => m.id === "p/a");
await Bun.sleep(150);
l = await a.list();
if (ids(l) !== "p/c,p/b") fail("exited terminal should be gone", l);

a.send({ op: "set", id: "p/b", title: "bee", attention: "!", color: "#ff5f5f" });
l = await a.list();
const b = l.terminals.find((t: any) => t.id === "p/b");
if (b.title !== "bee" || b.attention !== "!" || b.node !== "r:p/b") fail("set", b);
a.send({ op: "set", id: "p/zzz", title: "x" }); await a.until("error", (m) => /no terminal/.test(m.error));

// zoom and minimise are the window's own state
a.send({ op: "zoom", id: "p/b" });
l = await a.list();
if (!l.terminals.find((t: any) => t.id === "p/b").zoomed) fail("zoom", l);
a.send({ op: "zoom", id: "p/b", on: false });
a.send({ op: "minimise", id: "p/c" });
await a.until("minimised", (m) => m.id === "p/c" && m.on === true);
l = await a.list();
if (!l.terminals.find((t: any) => t.id === "p/c").minimised || l.terminals.find((t: any) => t.id === "p/b").zoomed) fail("minimise", l);
a.send({ op: "focus", id: "p/c" }); // focusing a minimised pane restores it
await a.until("minimised", (m) => m.id === "p/c" && m.on === false);

// a second tab, tab order, cycling
a.send({ op: "open", id: "q/x", tab: "q", title: "x", argv: ["sleep", "60"] });
await a.until("opened", (m) => m.id === "q/x");
a.send({ op: "tabs", order: ["q", "p"] });
l = await a.list();
if (l.tabs.join() !== "q,p") fail("tabs order", l);
a.send({ op: "tab", tab: "q", focus: true, color: "#5fd75f" });
await a.until("tab", (m) => m.tab === "q");
a.send({ op: "tab", cycle: 1 });
await a.until("tab", (m) => m.tab === "p");

// sidebar tree
a.send({ op: "tree", nodes: [
  { id: "p:p", label: "p", badge: "!", dot: "full", dotColor: "#5fd75f", color: "#5fafff", actions: [{ id: "project.add", label: "Add repo…", key: "a" }],
    children: [{ id: "r:p/b", label: "bee", dot: "half", actions: [{ id: "peer.shell", label: "Shell", key: "h" }] }] },
  { id: "p:q", label: "q", dot: "ring", dim: true }] });
a.send({ op: "sidebar", select: "r:p/b" });
l = await a.list();
if (l.nodes.length !== 3 || l.selected !== "r:p/b" || l.nodes.find((n: any) => n.id === "p:p").badge !== "!") fail("tree", l);

// menus: the driver's replace the built-in ones
a.send({ op: "menu", menus: [{ title: "&Test", items: [{ id: "app.new", label: "New", shortcut: "Ctrl+Shift+T", key: "n" }, { separator: true }, { id: "host.zoom", label: "Zoom", shortcuts: ["Ctrl+Shift+Z"] }] }] });
l = await a.list();
if (l.actions.join() !== "app.new,host.zoom") fail("menu", l);

// dialogs: asked, answered, cancelled
a.send({ op: "ask", id: "q1", title: "New project", schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, shared: { type: "boolean" }, mode: { type: "string", enum: ["a", "b"] }, g: { type: "object", properties: { n: { type: "integer", default: 3 } } } } }, values: { name: "x" } });
l = await a.list();
if (l.asks.join() !== "q1") fail("ask should be open", l);
a.send({ op: "answer", id: "q1", values: { name: "demo", shared: true } });
const ans = await a.until("answer", (m) => m.id === "q1");
if (ans.values.name !== "demo" || ans.values.shared !== true) fail("answer", ans);
a.send({ op: "ask", id: "q2", title: "Sure?", text: "really" });
await Bun.sleep(100);
a.send({ op: "answer", id: "q2", cancelled: true });
if ((await a.until("answer", (m) => m.id === "q2")).cancelled !== true) fail("cancel");
a.send({ op: "settings", schema: { type: "object", properties: { general: { type: "object", properties: { font: { type: "string" } } } } }, values: { general: { font: "Hack" } }, open: true });
await Bun.sleep(100);
a.send({ op: "answer", id: "settings", values: { general: { font: "Mono" } } });
if ((await a.until("settings")).values.general.font !== "Mono") fail("settings");

// events any client can raise, for every client: how tmux keys and tests reach the driver
const second = await client(sock);
await second.until("hello");
second.send({ op: "emit", event: { ev: "nudge", focus: "p/b" } });
if ((await a.until("nudge")).focus !== "p/b") fail("emit");
second.c.destroy();

a.send({ op: "notify", text: "hi", alert: true }); a.send({ op: "busy", text: "working" }); a.send({ op: "placeholder", text: "empty" });
a.send({ op: "font", size: 10 }); a.send({ op: "scheme", name: "Linux" });
a.send({ op: "bogus" }); await a.until("error", (m) => /unknown op/.test(m.error));

// closing a tab closes its terminals; the last one going leaves no tab
a.send({ op: "tab", tab: "p", close: true });
l = await a.list();
if (ids(l) !== "q/x" || l.tabs.join() !== "q") fail("tab close", l);

// one window per socket: a second start raises the first and leaves
const twin = Bun.spawn([bin, "--socket", sock], { env, stdout: "ignore", stderr: "ignore" });
if ((await twin.exited) !== 0) fail("second instance should exit 0");
a.send({ op: "ping" }); await a.until("pong");

a.send({ op: "quit" });
await a.until("quit");
if ((await host.exited) !== 0) fail("host exit code");

// --- the driver is the host's child: started with the socket in its environment, and
// started again when it dies
const sock2 = join(dir, "b.sock");
const marks = join(dir, "driver.marks");
const script = join(dir, "driver.sh");
writeFileSync(script, `#!/bin/sh\necho "$$ $MC_TERM_SOCKET" >> ${marks}\nexec sleep 300\n`);
chmodSync(script, 0o755);
const host2 = start(sock2, ["--driver", script]);
const b2 = await client(sock2);
await b2.until("hello");
const lines = () => (existsSync(marks) ? readFileSync(marks, "utf8").trim().split("\n").filter(Boolean) : []);
for (let i = 0; i < 100 && lines().length < 1; i++) await Bun.sleep(50);
if (lines().length !== 1 || lines()[0].split(" ")[1] !== sock2) fail("driver not started with the socket", lines());
process.kill(Number(lines()[0].split(" ")[0]));
for (let i = 0; i < 100 && lines().length < 2; i++) await Bun.sleep(50);
if (lines().length !== 2) fail("driver not restarted", lines());
b2.send({ op: "open", id: "p/a", argv: ["sleep", "60"] }); await b2.until("opened");
b2.send({ op: "quit" });
if ((await host2.exited) !== 0) fail("host2 exit code");
await Bun.sleep(300);
try { process.kill(Number(lines()[1].split(" ")[0]), 0); fail("driver should die with the host"); } catch { /* gone, as it should be */ }

clearTimeout(timer);
rmSync(dir, { recursive: true, force: true });
console.log("host smoke OK");
process.exit(0);
