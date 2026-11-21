// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// A tmux pane shown natively (control mode), offscreen, against a private tmux server:
// the state it starts from, typing, a flood, sizes, an alternate-screen program, reopening.
// Run: bun host/tests/native.ts [path-to-mc-term]
import { connect } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] ?? new URL("../build/mc-term", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "mc-term-native-"));
// A low hold threshold, so the flood below has to go through "the display is behind:
// make the program wait" several times, and still lose nothing.
const env: Record<string, string> = { ...(process.env as Record<string, string>), QT_QPA_PLATFORM: "offscreen", MC_TERM_NO_STATE: "1", TMUX_TMPDIR: dir, HOME: dir, MC_TERM_HIGH_WATER: "150000" };
delete env.TMUX; delete env.TMUX_PANE;
const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-f", "/dev/null", ...args], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString().trimEnd();
let host: ReturnType<typeof Bun.spawn> | null = null;
const fail = (m: string, extra?: unknown): never => {
  console.error("FAIL:", m, extra === undefined ? "" : "\n" + (typeof extra === "string" ? extra : JSON.stringify(extra, null, 1)));
  host?.kill(); tmux("kill-server");
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};
setTimeout(() => fail("timeout"), 150_000);

// a session the way my-claude's solo layout leaves it: one pane per window, sized by its viewer
tmux("new-session", "-d", "-s", "mc-n", "-n", "1", "-x", "100", "-y", "30", "env PS1='$ ' bash --norc --noprofile");
tmux("set-option", "-w", "-t", "mc-n:", "aggressive-resize", "off"); tmux("set-option", "-w", "-t", "mc-n:", "window-size", "smallest");
const [pane, win] = tmux("list-panes", "-t", "=mc-n", "-F", "#{pane_id} #{window_id}").split(" ");
tmux("send-keys", "-t", pane, "-l", "seq 1 400"); tmux("send-keys", "-t", pane, "Enter");
await Bun.sleep(400);

const sock = join(dir, "h.sock");
host = Bun.spawn([bin, "--socket", sock], { env, stdout: "ignore", stderr: "inherit" });
for (let i = 0; i < 80 && !existsSync(sock); i++) await Bun.sleep(50);
const c = connect(sock);
const got: any[] = [];
let buf = "";
c.on("data", (d) => { buf += d; for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
await new Promise((r, j) => { c.on("connect", r); c.on("error", j); });
const send = (o: object) => c.write(JSON.stringify(o) + "\n");
const until = async (ev: string, pred: (m: any) => boolean = () => true, what = ev, tries = 600) => {
  for (let i = 0; i < tries; i++) { const k = got.findIndex((x) => x.ev === ev && pred(x)); if (k >= 0) return got.splice(k, 1)[0]; await Bun.sleep(20); }
  return fail(`no ${what}`, got.slice(-6));
};
const term = async (id: string) => { send({ op: "list" }); return (await until("list")).terminals.find((t: any) => t.id === id); };
const screen = async (id: string, o: object = {}) => { send({ op: "screen", id, ...o }); return until("screen", (m) => m.id === id); };
const waitScreen = async (id: string, what: string, pred: (text: string) => boolean, ms = 8000) => {
  let s: any;
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) { s = await screen(id); if (pred(s.text)) return s; await Bun.sleep(100); }
  return fail(`screen never showed: ${what}`, s.text);
};
const type = (id: string, text: string) => send({ op: "send", id, text });
const paneSize = () => tmux("display-message", "-p", "-t", pane, "#{pane_width}x#{pane_height}");
const ID = `n/${pane}`;
await until("hello");

// --- it opens on the pane as it is: the scrollback tmux had, the screen, the cursor
send({ op: "open", id: ID, tab: "n", title: "native", tmux: { session: "mc-n", pane, window: win } });
const seeded = await until("seeded", (m) => m.id === ID);
if (seeded.history < 350) fail("the pane's history should have come along", seeded);
let t = await term(ID);
if (!t.native || !t.live) fail("native and live", t);
let s = await waitScreen(ID, "the end of seq and a prompt", (x) => /399\n400\n\$ *$/.test(x.trimEnd() + " ") || x.trimEnd().endsWith("400\n$"));
if (s.history < 350) fail("scrollback should hold the history", s);
const old = await screen(ID, { from: 0, to: 4 });
if (!/1\n2\n3/.test(old.text.replace(/^.*seq 1 400\n/s, ""))) fail("the oldest lines should be at the top of the scrollback", JSON.stringify(old));
// tmux's window follows the widget, cell for cell
for (let i = 0; i < 40 && paneSize() !== `${t.cols}x${t.rows}`; i++) await Bun.sleep(50);
if (paneSize() !== `${t.cols}x${t.rows}`) fail("the pane should have the widget's size", { tmux: paneSize(), widget: `${t.cols}x${t.rows}` });

// --- typing reaches the program, its output reaches the screen
type(ID, "echo NATIVE-$((6*7)) çé✓\r");
await waitScreen(ID, "the echo", (x) => x.includes("NATIVE-42 çé✓"));
if (!tmux("capture-pane", "-p", "-t", pane).includes("NATIVE-42 çé✓")) fail("tmux should have seen the same");

// --- a flood: everything arrives, nothing piles up, the window keeps answering
const pid = host.pid;
const rss = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) / 1024;
const before = rss();
type(ID, "seq 1 300000; echo FLOOD-DONE\r");
let worst = 0, held = false, peak = 0;
for (const t0 = Date.now(); ; ) {
  const p0 = performance.now();
  send({ op: "ping" }); await until("pong");
  worst = Math.max(worst, performance.now() - p0);
  const now = await term(ID);
  held ||= now.held; peak = Math.max(peak, now.pending);
  const sc = await screen(ID);
  if (sc.text.includes("FLOOD-DONE\n$") || sc.text.trimEnd().endsWith("FLOOD-DONE\n$")) break;
  if (Date.now() - t0 > 90_000) fail("flood never finished", sc.text.slice(-300));
  await Bun.sleep(50);
}
t = await term(ID);
const after = rss();
console.log(`flood of 300000 lines: scrollback ${t.history} lines, window answered within ${worst.toFixed(0)} ms throughout, memory ${before.toFixed(0)} -> ${after.toFixed(0)} MB, most waiting ${(peak / 1e6).toFixed(1)} MB${held ? ", pane was held at least once" : ""}`);
if (t.history < 300000) fail("every line should be in the scrollback", t);
if (!held) fail("the flood should have had the pane held at least once (the test lowers the threshold for that)");
if (worst > 500) fail(`the window stalled for ${worst.toFixed(0)} ms during the flood`);
if (after - before > 250) fail(`memory grew by ${(after - before).toFixed(0)} MB during the flood`);
// no gaps: a stretch from the middle is consecutive
const mid = (await screen(ID, { from: t.history - 150000, to: t.history - 149990 })).text.trim().split("\n").map(Number);
if (mid.length < 8 || mid.some((n, i) => i > 0 && n !== mid[i - 1] + 1)) fail("the scrollback has a gap", mid);

// --- the grid changes, the pane follows
send({ op: "open", id: "n/other", tab: "n", title: "other", argv: ["sleep", "100"] });
await until("opened", (m) => m.id === "n/other");
let now = await term(ID);
for (let i = 0; i < 60 && (now.cols === t.cols || paneSize() !== `${now.cols}x${now.rows}`); i++) { await Bun.sleep(50); now = await term(ID); }
if (now.cols === t.cols) fail("opening a second terminal should have narrowed the first", now);
if (paneSize() !== `${now.cols}x${now.rows}`) fail("the pane should follow a resize", { tmux: paneSize(), widget: `${now.cols}x${now.rows}` });
type(ID, "stty size\r");
await waitScreen(ID, "the program's own idea of its size", (x) => x.includes(`${now.rows} ${now.cols}`));

// --- a full-screen program, and coming back to it: the window reopens on the same state
type(ID, "seq 1 2000 | less\r");
await waitScreen(ID, "less", (x) => /^1\n2\n3/.test(x) && /:\s*$/.test(x.trimEnd()));
send({ op: "close", id: ID });
await Bun.sleep(200);
send({ op: "open", id: ID, tab: "n", title: "native", tmux: { session: "mc-n", pane, window: win } });
await until("seeded", (m) => m.id === ID);
s = await waitScreen(ID, "less again after reopening", (x) => /^1\n2\n3/.test(x));
type(ID, "G");
await waitScreen(ID, "less at the end", (x) => x.includes("2000"));
type(ID, "q");
s = await waitScreen(ID, "the shell again", (x) => x.trimEnd().endsWith("$") && x.includes("stty size"));
t = await term(ID);
if (t.history < 1000) fail("scrollback should have come back from tmux after reopening", t);

// --- the session dies: its panes go, the window stays
tmux("kill-session", "-t", "=mc-n");
await until("exited", (m) => m.id === ID);
send({ op: "ping" }); await until("pong");
send({ op: "quit" });
if ((await host.exited) !== 0) fail("exit code");
tmux("kill-server");
rmSync(dir, { recursive: true, force: true });
console.log("native pane OK");
process.exit(0);
