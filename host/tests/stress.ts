// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// The window under load and failure: floods, resize storms, junk output, churn, tmux dying,
// the window killed and restarted.
// Run: bun host/tests/stress.ts [path-to-mc-term]
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] ?? new URL("../build/mc-term", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "mc-term-stress-"));
const env: Record<string, string> = { ...(process.env as Record<string, string>), QT_QPA_PLATFORM: "offscreen", MC_TERM_NO_STATE: "1", MC_TERM_TEST: "1", TMUX_TMPDIR: dir, HOME: dir, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
delete env.TMUX; delete env.TMUX_PANE;
const tmuxRaw = (...a: string[]) => Bun.spawnSync(["tmux", "-f", "/dev/null", ...a], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString();
const tmux = (...a: string[]) => tmuxRaw(...a).trimEnd();
let host: ReturnType<typeof Bun.spawn> | null = null;
let c: Socket;
let got: any[] = [];
const fail = (m: string, extra?: unknown): never => {
  console.error("FAIL:", m, extra === undefined ? "" : "\n" + (typeof extra === "string" ? extra : JSON.stringify(extra, null, 1)));
  host?.kill(); tmux("kill-server"); rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};
setTimeout(() => fail("timeout"), 280_000);
const sock = join(dir, "h.sock");
const start = async () => {
  host = Bun.spawn([bin, "--socket", sock], { env, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(50);
  got = [];
  let buf = "";
  c = connect(sock);
  c.on("data", (d) => { buf += d; for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
  c.on("error", () => {});
  await new Promise((r) => c.on("connect", r));
  await until("hello");
  send({ op: "resize", w: 1400, h: 900 });
};
const send = (o: object) => c.write(JSON.stringify(o) + "\n");
const until = async (ev: string, pred: (m: any) => boolean = () => true, what = ev, tries = 3000) => {
  for (let i = 0; i < tries; i++) { const k = got.findIndex((x) => x.ev === ev && pred(x)); if (k >= 0) return got.splice(k, 1)[0]; await Bun.sleep(10); }
  return fail(`no ${what}`, got.slice(-6));
};
const list = async () => { send({ op: "list" }); return until("list"); };
const term = async (id: string) => (await list()).terminals.find((t: any) => t.id === id);
const screen = async (id: string, o: object = {}) => { send({ op: "screen", id, ...o }); return until("screen", (m) => m.id === id); };
const ping = async () => { const t0 = performance.now(); send({ op: "ping" }); await until("pong"); return performance.now() - t0; };
const rss = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${host!.pid}/status`, "utf8"))![1]) / 1024;
const fds = () => readdirSync(`/proc/${host!.pid}/fd`).length;
const trim = (s: string) => { const r = s.split("\n").map((x) => x.replace(/ +$/, "")); while (r.length && r[r.length - 1] === "") r.pop(); return r; };
const SH = "env PS1='$ ' bash --norc --noprofile";
type P = { p: string; w: string; id: string };
tmux("new-session", "-d", "-s", "mc-s", "-n", "boot", "-x", "120", "-y", "40", SH);
tmux("set-option", "-g", "history-limit", "20000");
const pane = (): P => { const [p, w] = tmux("new-window", "-d", "-P", "-F", "#{pane_id} #{window_id}", "-t", "mc-s:", SH).split(" "); return { p, w, id: `s/${p}` }; };
const open = (x: P) => send({ op: "open", id: x.id, tab: "s", title: x.p, tmux: { session: "mc-s", pane: x.p, window: x.w } });
const run = (x: P, line: string) => { tmux("send-keys", "-t", x.p, "-l", line); tmux("send-keys", "-t", x.p, "Enter"); };
const parity = async (x: P, what: string, ms = 15000) => {
  let last: any;
  for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(150)) {
    const s = await screen(x.id);
    const theirs = trim(tmuxRaw("capture-pane", "-p", "-t", x.p)), mine = trim(s.text);
    const [tx, ty, tw, th] = tmux("display-message", "-p", "-t", x.p, "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}").split(" ").map(Number);
    last = { widget: `${s.cols}x${s.rows} ${s.cx},${s.cy}`, tmux: `${tw}x${th} ${tx},${ty}`, first: mine.findIndex((r, i) => r !== theirs[i]), mine: mine.slice(-3), theirs: theirs.slice(-3) };
    if (mine.join("\n") === theirs.join("\n") && tw === s.cols && th === s.rows && s.cx === tx && s.cy === ty) return;
  }
  fail(`${what}: the widget does not show what tmux holds`, last);
};

await start();
const panes = Array.from({ length: 8 }, pane);

// --- 1. eight panes (four on screen, four behind), all flooding at once
panes.forEach(open);
for (const x of panes.slice(0, 4)) await until("seeded", (m) => m.id === x.id, `${x.id} seeded`);
{
  const N = 150000, before = rss(), t0 = Date.now();
  panes.forEach((x, i) => run(x, `seq 1 ${N}; echo done-${i}`));
  let worst = 0, peak = before;
  for (;;) {
    worst = Math.max(worst, await ping());
    peak = Math.max(peak, rss());
    const done = panes.filter((x, i) => tmux("capture-pane", "-p", "-t", x.p).includes(`done-${i}`)).length;
    if (done === panes.length) break;
    if (Date.now() - t0 > 120_000) fail("the floods never finished", { done });
    await Bun.sleep(40);
  }
  const secs = (Date.now() - t0) / 1000;
  // those on screen show the end, exactly; every one of the eight is live or will be when shown
  for (const x of panes.slice(0, 4)) await parity(x, "after the floods");
  for (const x of panes.slice(0, 4)) { const t = await term(x.id); if (t.history + t.rows < N) fail("a flooded pane lost lines", { id: x.id, history: t.history, rows: t.rows }); }
  console.log(`8 panes x ${N} lines at once: ${secs.toFixed(1)} s, the window answered within ${worst.toFixed(0)} ms throughout, memory ${before.toFixed(0)} -> peak ${peak.toFixed(0)} MB`);
  if (worst > 400) fail(`the window stalled for ${worst.toFixed(0)} ms`);
  if (peak - before > 400) fail(`memory grew by ${(peak - before).toFixed(0)} MB`);
  // the ones behind: brought on screen now, they have their own flood's end too
  send({ op: "focus", id: panes[4].id });
  for (const x of panes.slice(4)) await parity(x, "a pane that was behind during its flood");
  send({ op: "focus", id: panes[0].id });
  await Bun.sleep(300);
}

// --- 2. a storm of resizes in the middle of a flood
{
  const x = panes[0];
  run(x, "clear; seq 1 400000; echo storm-over");
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    send({ op: "resize", w: 700 + ((i * 197) % 900), h: 450 + ((i * 113) % 500) });
    worst = Math.max(worst, await ping());
    await Bun.sleep(35);
  }
  send({ op: "resize", w: 1400, h: 900 });
  for (let i = 0; i < 600 && !tmux("capture-pane", "-p", "-t", x.p).includes("storm-over"); i++) await Bun.sleep(100);
  await parity(x, "after a storm of resizes during a flood", 30000);
  for (const y of panes.slice(1, 4)) await parity(y, "a neighbour after the storm", 30000);
  console.log(`40 resizes during a flood: the window answered within ${worst.toFixed(0)} ms, all panes back in step with tmux`);
}

// --- 3. what no terminal should be sent: binary noise, a megabyte on one line
{
  const x = panes[1];
  run(x, "head -c 3000000 /dev/urandom; printf '\\033c'; clear; echo noise-over");
  for (let i = 0; i < 300 && !tmux("capture-pane", "-p", "-t", x.p).includes("noise-over"); i++) await Bun.sleep(100);
  const p = await ping();
  if (p > 400) fail(`the window stalled for ${p.toFixed(0)} ms after binary noise`);
  run(x, "clear; head -c 1000000 /dev/zero | tr '\\0' 'x'; echo; echo line-over");
  for (let i = 0; i < 300 && !tmux("capture-pane", "-p", "-t", x.p).includes("line-over"); i++) await Bun.sleep(100);
  // noise can leave either side in a mode of its own; a reset and a new screen, and they agree again
  run(x, "reset; clear; echo sane-again");
  await Bun.sleep(1500);
  send({ op: "resize", w: 1380, h: 880 }); await Bun.sleep(200); send({ op: "resize", w: 1400, h: 900 });
  await parity(x, "after noise, a megabyte line and a reset", 30000);
  console.log("3 MB of binary noise and a 1 MB line: survived, back in step after a reset");
}

// --- 4. panes opened and closed in a hurry: nothing left behind
{
  const f0 = fds(), m0 = rss();
  for (let i = 0; i < 25; i++) {
    for (const x of panes.slice(4)) send({ op: "close", id: x.id });
    await Bun.sleep(30 + (i % 3) * 40);
    for (const x of panes.slice(4)) open(x);
    await Bun.sleep(30 + (i % 4) * 60);
  }
  await Bun.sleep(1500);
  const l = await list();
  if (l.terminals.length !== 8) fail("eight terminals after the churn", l.terminals.map((t: any) => t.id));
  const clients = tmux("list-clients", "-F", "#{client_control_mode}").split("\n").filter((x) => x === "1").length;
  if (clients !== 1) fail(`one control client should serve the session, there are ${clients}`);
  const f1 = fds(), m1 = rss();
  if (f1 - f0 > 12) fail(`file descriptors leaked: ${f0} -> ${f1}`);
  console.log(`25 rounds of closing and opening four panes: ${f0} -> ${f1} descriptors, memory ${m0.toFixed(0)} -> ${m1.toFixed(0)} MB, one control client`);
}

// --- a window that hangs must not hold the programs: after a few seconds tmux lets them
// run on, and the window catches up when it is back
{
  const x = panes[3];
  send({ op: "focus", id: x.id });
  run(x, "clear; i=0; while :; do i=$((i+1)); echo tick-$i; done");
  await Bun.sleep(1500);
  const tick = () => Number(/tick-(\d+)\s*$/.exec(tmux("capture-pane", "-p", "-t", x.p))?.[1] ?? 0);
  process.kill(host!.pid, "SIGSTOP");
  await Bun.sleep(1000);
  const held = tick();
  await Bun.sleep(1200);
  const stillHeld = tick();
  await Bun.sleep(6500); // past the five seconds
  const free1 = tick(); await Bun.sleep(1000); const free2 = tick();
  process.kill(host!.pid, "SIGCONT");
  if (free2 - free1 < 1000) fail("with the window stopped for more than five seconds, the program should be running again", { held, stillHeld, free1, free2 });
  await until("fell-behind", (m) => m.id === x.id, "the window noticing it fell behind", 2000);
  await until("seeded", (m) => m.id === x.id);
  tmux("send-keys", "-t", x.p, "C-c");
  run(x, "clear; echo caught-up");
  await parity(x, "after the window hung and came back");
  console.log(`the window stopped for 9 s under a flood: the program was not held (${free2 - free1} lines a second while the window was stopped), and the window caught up when it came back`);
}

// --- 5. the window is killed outright: the programs do not notice, a new window finds them
{
  const x = panes[2];
  run(x, "clear; for i in $(seq 1 300); do echo survived-$i; done");
  await Bun.sleep(500);
  const pid = tmux("display-message", "-p", "-t", x.p, "#{pane_pid}");
  host!.kill(9);
  await host!.exited;
  if (!existsSync(`/proc/${pid}`)) fail("the pane's shell must outlive the window");
  rmSync(sock, { force: true });
  await start();
  open(x);
  const seeded = await until("seeded", (m) => m.id === x.id);
  if (seeded.history < 250) fail("a new window should get the pane's scrollback from tmux", seeded);
  await parity(x, "a pane found again by a new window");
  run(x, "echo and-still-typing");
  await parity(x, "typing into it");
  console.log("the window killed with -9: the pane's shell lived on, a new window showed it with its scrollback");
}

// --- 6. tmux itself goes: the terminals close, the window stays
{
  for (const x of panes.slice(0, 2)) open(x);
  await Bun.sleep(600);
  tmux("kill-server");
  await until("exited", () => true, "the panes ending with tmux");
  await Bun.sleep(800);
  const p = await ping();
  const l = await list();
  if (l.terminals.length) fail("no terminal should be left once tmux is gone", l.terminals.map((t: any) => t.id));
  console.log(`tmux killed: its panes closed, the window still answers (${p.toFixed(0)} ms)`);
}

send({ op: "quit" });
if ((await host!.exited) !== 0) fail("exit code");
rmSync(dir, { recursive: true, force: true });
console.log("stress OK");
process.exit(0);
