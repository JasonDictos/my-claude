// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// A native pane shows what tmux holds (rows, cursor, scrollback) through opens, resizes and
// full-screen programs, and typing reaches the program as tmux would pass it.
// Run: bun host/tests/parity.ts [path-to-mc-term]     (PARITY_ONLY=<name> runs one part)
import { connect } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] ?? new URL("../build/mc-term", import.meta.url).pathname;
const repo = new URL("../..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "mc-term-parity-"));
const env: Record<string, string> = { ...(process.env as Record<string, string>), QT_QPA_PLATFORM: "offscreen", MC_TERM_NO_STATE: "1", MC_TERM_TEST: "1", TMUX_TMPDIR: dir, HOME: dir, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
delete env.TMUX; delete env.TMUX_PANE;
const tmuxRaw = (...args: string[]) => Bun.spawnSync(["tmux", "-f", "/dev/null", ...args], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString();
const tmux = (...args: string[]) => tmuxRaw(...args).trimEnd();
let host: ReturnType<typeof Bun.spawn> | null = null;
const fail = (m: string, extra?: unknown): never => {
  console.error("FAIL:", m, extra === undefined ? "" : "\n" + (typeof extra === "string" ? extra : JSON.stringify(extra, null, 1)));
  if (!process.env.PARITY_KEEP) { host?.kill(); tmux("kill-server"); rmSync(dir, { recursive: true, force: true }); }
  process.exit(1);
};
setTimeout(() => fail("timeout"), 280_000);
const only = process.env.PARITY_ONLY;
const part = (name: string) => !only || only === name;

const SH = "env PS1='$ ' bash --norc --noprofile";
tmux("new-session", "-d", "-s", "mc-p", "-n", "boot", "-x", "240", "-y", "70", SH);
tmux("set-option", "-g", "history-limit", "5000");
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
await until("hello");
const screen = async (id: string, o: object = {}) => { send({ op: "screen", id, ...o }); return until("screen", (m) => m.id === id); };
const term = async (id: string) => { send({ op: "list" }); return (await until("list")).terminals.find((t: any) => t.id === id); };
// What tmux would draw for a pane: its rows captured with escapes, colours and links off,
// line-drawing cells (between SO and SI) as the box characters they are.
const ACS = "◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·";
const drawn = (pane: string, ...range: string[]) => {
  const raw = tmuxRaw("capture-pane", "-p", "-e", ...(range.length ? range : ["-S", "0", "-E", "-"]), "-t", pane).replace(/\n$/, "");
  return raw.split("\n").map((row) => {
    let out = "", g = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === "\x0e") g = true;
      else if (ch === "\x0f") g = false;
      else if (ch === "\x1b" && row[i + 1] === "[") { for (i += 2; i < row.length && !(row[i] >= "@" && row[i] <= "~"); i++); }
      else if (ch === "\x1b" && row[i + 1] === "]") { for (i += 2; i < row.length && row[i] !== "\x07" && !(row[i] === "\x1b" && row[i + 1] === "\\"); i++); if (row[i] === "\x1b") i++; }
      else if (ch === "\t") out += " ".repeat(8 - ([...out].length % 8)); // a tab cell: blanks up to the next stop
      else out += g && ch >= "`" && ch <= "~" ? ACS[ch.charCodeAt(0) - 0x60] : ch;
    }
    return out.replace(/ +$/, "");
  });
};
const trimRows = (s: string) => { const r = s.split("\n").map((x) => x.replace(/ +$/, "")); while (r.length && r[r.length - 1] === "") r.pop(); return r; };

// A pane in a window of its own, the way the solo layout has them; shown in tab `tab`.
let nth = 0;
const pane = (cmd = SH, size = "240x70") => {
  const [x, y] = size.split("x");
  tmux("set-option", "-t", "=mc-p:", "default-size", `${x}x${y}`);
  const [p, w] = tmux("new-window", "-d", "-P", "-F", "#{pane_id} #{window_id}", "-t", "mc-p:", "-n", `w${++nth}`, cmd).split(" ");
  return { p, w, id: `p/${p}` };
};
const open = async (x: { p: string; w: string; id: string }, tab = "p") => {
  send({ op: "open", id: x.id, tab, title: x.p, tmux: { session: "mc-p", pane: x.p, window: x.w }, focus: true });
  return until("seeded", (m) => m.id === x.id, `the pane ${x.p} seeded`);
};
const close = async (x: { id: string }) => { send({ op: "close", id: x.id }); await Bun.sleep(80); };
const type = (x: { p: string }, text: string) => tmux("send-keys", "-t", x.p, "-l", text);
const enter = (x: { p: string }) => tmux("send-keys", "-t", x.p, "Enter");
const run = (x: { p: string }, line: string) => { type(x, line); enter(x); };
const script = (name: string, body: string) => { const f = join(dir, name); writeFileSync(f, body); return f; };

// The widget against tmux, until they agree or time runs out.
const parity = async (x: { p: string; id: string }, what: string, o: { ms?: number; cursor?: boolean } = {}) => {
  let last: any = null;
  for (const t0 = Date.now(); Date.now() - t0 < (o.ms ?? 6000); await Bun.sleep(120)) {
    const s = await screen(x.id);
    const theirs = trimRows(drawn(x.p).join("\n"));
    const mine = trimRows(s.text);
    const [tx, ty, tw, th] = tmux("display-message", "-p", "-t", x.p, "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}").split(" ").map(Number);
    const rowsSame = mine.length === theirs.length && mine.every((r, i) => r === theirs[i]);
    const sizeSame = tw === s.cols && th === s.rows;
    const cursorSame = o.cursor === false || (s.cx === tx && s.cy === ty);
    last = { mine, theirs, widget: `${s.cols}x${s.rows} cursor ${s.cx},${s.cy}`, tmux: `${tw}x${th} cursor ${tx},${ty}` };
    if (rowsSame && sizeSame && cursorSame) {
      // And it draws what it holds: a widget keeps a picture, which can go stale. Asking
      // brings the picture up to date, so there is one look, after a moment to settle.
      await Bun.sleep(150);
      send({ op: "stale", id: x.id });
      const d = await until("stale", (m) => m.id === x.id);
      if (!d.told) fail(`${what}: the widget cannot be told to redraw`);
      if (d.stale) fail(`${what}: the widget holds what tmux holds but draws something else`);
      return s;
    }
  }
  const n = Math.max(last.mine.length, last.theirs.length);
  const diff: string[] = [];
  for (let i = 0; i < n && diff.length < 16; i++) if (last.mine[i] !== last.theirs[i]) diff.push(`row ${i}\n   tmux   ${JSON.stringify(last.theirs[i])}\n   widget ${JSON.stringify(last.mine[i])}`);
  return fail(`${what}: the widget does not show what tmux holds (widget ${last.widget}, tmux ${last.tmux})`, diff.join("\n"));
};
// The scrollback, row for row.
const scrollbackParity = async (x: { p: string; id: string }, what: string) => {
  let last: any = null;
  for (const t0 = Date.now(); Date.now() - t0 < 6000; await Bun.sleep(150)) {
    const t = await term(x.id);
    const hist = Number(tmux("display-message", "-p", "-t", x.p, "#{history_size}"));
    const theirs = hist ? drawn(x.p, "-S", "-", "-E", "-1") : [];
    const mine = t.history ? (await screen(x.id, { from: 0, to: t.history - 1 })).text.split("\n").map((r: string) => r.replace(/ +$/, "")) : [];
    last = { mine, theirs };
    if (mine.length === theirs.length && mine.every((r: string, i: number) => r === theirs[i])) return mine;
  }
  const n = Math.max(last.mine.length, last.theirs.length);
  const diff: string[] = [`widget ${last.mine.length} rows, tmux ${last.theirs.length} rows`];
  for (let i = 0; i < n && diff.length < 12; i++) if (last.mine[i] !== last.theirs[i]) diff.push(`row ${i}\n   tmux   ${JSON.stringify(last.theirs[i])}\n   widget ${JSON.stringify(last.mine[i])}`);
  return fail(`${what}: the scrollback differs`, diff.join("\n"));
};
const resize = async (w: number, h: number) => { send({ op: "resize", w, h }); await Bun.sleep(150); };

await resize(900, 520);

// --- 1. a pane that lived at another size (what broke the first demo): made at 240x70, a
// transcript with long lines and more than a screenful, then shown in a small terminal
if (part("open")) {
  const a = pane();
  const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: ` + "the quick brown fox jumps over the lazy dog ".repeat(1 + (i % 4))).join("\n");
  const f = script("transcript.txt", readFileSync(join(repo, "tests/say/api.txt"), "utf8") + "\n" + long + "\n");
  run(a, `cat ${f}`);
  await Bun.sleep(300);
  const seeded = await open(a);
  if (seeded.history < 20) fail("the pane's scrollback should have come along", seeded);
  await parity(a, "a pane first shown smaller than it was");
  const sb = await scrollbackParity(a, "a pane first shown smaller than it was");
  if (sb.filter((r: string) => r.includes("Addressed the review on PR #42")).length !== 1) fail("the transcript's first line should be in the scrollback once", sb.slice(0, 8));
  // --- 2. every kind of resize: narrower, wider, shorter, taller, and back
  for (const [w, h, what] of [[620, 520, "narrower"], [1300, 520, "wider"], [1300, 300, "shorter"], [1300, 800, "taller"], [700, 400, "smaller both ways"], [900, 520, "back"]] as const) {
    await resize(w, h);
    await parity(a, `after a resize (${what})`);
    await scrollbackParity(a, `after a resize (${what})`);
  }
  // and what is written after all that lands where tmux puts it
  run(a, "echo after-the-resizes; seq 1 5");
  await parity(a, "output after resizes");
  await close(a);
}

// --- 3. what modern programs write
if (part("dialect")) {
  const a = pane(SH, "100x30");
  await open(a);
  const E = "\\033";
  const cases: [string, string][] = [
    ["colours, both spellings", `printf '${E}[1;31mbold red${E}[0m ${E}[38;5;196mindexed${E}[0m ${E}[38;2;10;200;30mrgb${E}[0m ${E}[38:2::10:200:30mrgb colon${E}[0m ${E}[38:5:196mindexed colon${E}[0m\\n'`],
    ["underline styles and colours", `printf '${E}[4:3mcurly${E}[4:0m ${E}[58:2::255:0:0m${E}[4mred underline${E}[59m${E}[24m ${E}[58;5;196mold form${E}[0m plain\\n'`],
    ["hyperlinks", `printf '${E}]8;;https://example.com/a${E}\\\\a link${E}]8;;${E}\\\\ and text\\n'`],
    ["keyboard protocol and modifier options", `printf 'a${E}[>1ub${E}[<uc${E}[?ud${E}[>4;2me${E}[=1;1uf\\n'`],
    ["strings for the terminal", `printf 'a${E}P+q544e${E}\\\\b${E}_Gf=100;AAAA${E}\\\\c${E}]133;A\\007d${E}]7;file://h/p\\007e${E}]9;4;1;50\\007f\\n'`],
    ["tmux passthrough", `printf 'a${E}Ptmux;${E}${E}]9;hi\\007${E}\\\\b\\n'`],
    ["window operations and version", `printf 'a${E}[22;0;0tb${E}[23;0;0tc${E}[>0qd\\n'`],
    ["synchronised output, cursor shapes", `printf '${E}[?2026hsync${E}[?2026l ${E}[5 qbar${E}[0 q\\n'`],
    ["wide and combining characters", `printf '日本語 text | emoji 🙂 ok | é ñ ü | ✓ ✔ ✗ ● ○ ❯ › ⎿ ⏺ ✻ ✽ ✢ … · • ─│┌┐└┘╭╮╰╯ | end\\n'`],
    ["line drawing charset", `printf '${E}(0lqqqk${E}(B\\n${E}(0x   x${E}(B\\n${E}(0mqqqj${E}(B\\n'`],
    ["tabs and backspaces", `printf 'a\\tb\\tc\\n12345\\b\\b\\bXY\\n'`],
    ["a redraw in place (what a prompt UI does)", `printf 'one\\ntwo\\nthree\\nfour\\n'; printf '${E}[3A${E}[2KTWO${E}[1B\\r${E}[2KTHREE${E}[1B\\r${E}[2KFOUR\\n'`],
    ["a scroll region", `printf '${E}[5;10r${E}[10;1H'; for i in 1 2 3 4 5 6 7 8 9; do printf 'region %s\\n' $i; done; printf '${E}[r${E}[20;1Hdone\\n'`],
    ["insert and delete lines and characters", `printf 'abcdefgh\\n12345678\\nxyz\\n${E}[3A${E}[2L${E}[4Bend ${E}[2A${E}[3G${E}[2P${E}[2@${E}[3B\\n'`],
    ["erase and repeat", `printf 'abcdefgh${E}[4D${E}[K\\nx${E}[5b|\\n${E}[2Ctab${E}[1K!\\n'`],
    ["save and restore the cursor", `printf 'top${E}7\\n\\n\\nlow${E}8 back\\n\\n\\n\\n'`],
  ];
  for (const [what, line] of cases) {
    run(a, line);
    await parity(a, what);
  }
  // queries: tmux answers them, once; an answer from the widget too would reach the program as typing
  const q = script("queries.sh", `stty raw -echo min 0 time 6\nprintf '\\033[c\\033[>c\\033[6n\\033[5n\\033Z\\005\\033[?2026$p\\033[>0q'\ndd bs=1 count=300 2>/dev/null | od -An -c | tr -d ' \\n' > ${dir}/answers\nstty sane\necho done-asking\n`);
  run(a, `clear; bash ${q}`);
  for (let i = 0; i < 60 && !tmux("capture-pane", "-p", "-t", a.p).includes("done-asking"); i++) await Bun.sleep(100);
  const answers = existsSync(join(dir, "answers")) ? readFileSync(join(dir, "answers"), "utf8") : "";
  if (!answers.includes("033[") ) fail("tmux should have answered the queries", answers);
  if (answers.includes(">0;115;0c")) fail("the widget answered a query tmux had already answered", answers);
  if ((answers.match(/\d+;\d+R/g) ?? []).length !== 1) fail("exactly one cursor report should reach the program", answers);
  if ((answers.match(/\[\?[\d;]*c/g) ?? []).length !== 1) fail("the one device attributes question tmux answers should be answered once", answers);
  if ((answers.match(/\[0n/g) ?? []).length !== 1) fail("exactly one status report should reach the program", answers);
  await parity(a, "after the queries");
  // a program copies text: it lands on the clipboard, nothing shows
  run(a, `clear; printf 'copied${E}]52;c;%s\\007.\\n' "$(printf 'from a program' | base64)"`);
  await parity(a, "after a clipboard write");
  await close(a);
}

// --- 4. programs that take the whole screen
if (part("fullscreen")) {
  const a = pane(SH, "100x30");
  await open(a);
  const f = script("numbers.txt", Array.from({ length: 500 }, (_, i) => `row ${i + 1} ${"x".repeat(i % 90)}`).join("\n") + "\n");
  run(a, `less ${f}`);
  await parity(a, "less");
  type(a, " ");
  await parity(a, "less, a page on");
  await resize(700, 420);
  await parity(a, "less after a resize");
  await resize(900, 520);
  await parity(a, "less after resizing back");
  type(a, "q");
  await parity(a, "the shell after less");
  if (Bun.which("vim")) {
    run(a, `vim -u NONE -N ${f}`);
    await parity(a, "vim");
    type(a, "50Gihello from the test"); tmux("send-keys", "-t", a.p, "Escape");
    await parity(a, "vim after an insert");
    await resize(640, 380);
    await parity(a, "vim after a resize");
    await resize(900, 520);
    await parity(a, "vim after resizing back");
    type(a, ":q!"); enter(a);
    await parity(a, "the shell after vim");
  }
  // opened while a full-screen program is up: the screen under it comes along too
  run(a, `less ${f}`);
  await parity(a, "less again");
  await close(a);
  await open(a);
  await parity(a, "reopened onto less");
  type(a, "q");
  await parity(a, "the shell under less, after reopening");
  await close(a);
}

// --- 5. keys reach the program the way tmux passes them on
if (part("keys")) {
  const a = pane(SH, "100x30");
  await open(a);
  run(a, "cat -v");
  await Bun.sleep(200);
  send({ op: "focus", id: a.id });
  for (const k of ["Home", "End", "Shift+F1", "Ctrl+Left", "Shift+Tab", "x", "Shift+Return"]) { send({ op: "key", keys: k }); await until("keyed"); }
  const s = await parity(a, "after keys");
  // this pane's text bigger, then back: the program gets the new size each time
  send({ op: "menu", menus: [{ title: "t", items: [{ id: "host.pane-text-bigger", label: "b", shortcuts: ["Ctrl+="] }, { id: "host.pane-text-reset", label: "r", shortcuts: ["Ctrl+0"] }, { id: "host.pane-next", label: "n", shortcuts: ["Ctrl+Shift+Tab"] }] }] });
  const before = (await term(a.id)).cols;
  for (let i = 0; i < 3; i++) { send({ op: "key", keys: "Ctrl+=" }); await until("keyed"); }
  await Bun.sleep(300);
  const bigger = await term(a.id);
  if (bigger.cols >= before) fail("bigger text should mean fewer columns", { before, after: bigger.cols });
  await parity(a, "after this pane's text got bigger");
  send({ op: "key", keys: "Ctrl+0" }); await until("keyed"); await Bun.sleep(300);
  if ((await term(a.id)).cols !== before) fail("Ctrl+0 should bring the size back");
  await parity(a, "after this pane's text size was reset");
  if (!s.text.includes("^[[1~^[[4~^[[1;2P^[[1;5D^[[Zx\n")) fail("Home, End, Shift+F1, Ctrl+Left, Shift+Tab, x, then Shift+Enter as a new line", s.text);
  await close(a);
}

// --- 6. a new layout around idle panes: every one still draws what it holds
if (part("layout")) {
  const a = pane(SH, "100x30"), b = pane(SH, "100x30"), d = pane(SH, "100x30");
  for (const x of [a, b, d]) { run(x, `printf 'pane ${"%s"} of three\\n' ${"$"}{TMUX_PANE}; seq 1 12`); }
  await open(a); await open(b);
  await parity(a, "two panes, the first"); await parity(b, "two panes, the second");
  await open(d); // the grid is laid out again around the two idle ones
  for (const x of [a, b, d]) await parity(x, "three panes");
  send({ op: "zoom", id: b.id, on: true }); await Bun.sleep(200);
  await parity(b, "zoomed");
  send({ op: "zoom", id: b.id, on: false }); await Bun.sleep(200);
  for (const x of [a, b, d]) await parity(x, "after the zoom");
  send({ op: "minimise", id: a.id, on: true }); await Bun.sleep(200);
  for (const x of [b, d]) await parity(x, "one minimised");
  send({ op: "minimise", id: a.id, on: false }); await Bun.sleep(200);
  for (const x of [a, b, d]) await parity(x, "restored");
  const e = pane(SH, "100x30");
  await open(e, "q"); // another tab comes to the front, then back
  await parity(e, "a pane in another tab");
  send({ op: "tab", tab: "p", focus: true }); await Bun.sleep(200);
  for (const x of [a, b, d]) await parity(x, "back on the first tab");
  await close(d); await Bun.sleep(150); // and the grid closes up again
  for (const x of [a, b]) await parity(x, "after one closed");
  for (const x of [a, b, e]) await close(x);
}

// --- a pane with more scrollback than a window fetches: it starts with the last of it
if (part("seed-cap")) {
  const a = pane(SH, "100x30");
  run(a, "seq 1 3000");
  await Bun.sleep(600);
  send({ op: "look", seedLines: 500 });
  const seeded = await open(a);
  if (seeded.history !== 500) fail("a pane should start with the last seedLines of tmux's scrollback", seeded);
  await parity(a, "a pane started with part of its scrollback");
  const t = await term(a.id);
  const top = (await screen(a.id, { from: 0, to: 2 })).text.split("\n").map(Number);
  if (top[1] !== top[0] + 1 || top[0] < 2400) fail("the scrollback should be the latest lines, in order", { top, history: t.history });
  send({ op: "look", seedLines: 50000 });
  await close(a);
}

// --- see-through terminals: only the terminals' background, and only when asked
if (part("transparency")) {
  const a = pane(SH, "100x30");
  await open(a);
  // (looked at once the pane's state is in and it paints again)
  const alpha = async () => { for (;;) { send({ op: "alpha", id: a.id }); const r = await until("alpha", (m) => m.id === a.id); if (!r.frozen) return r; await Bun.sleep(50); } };
  await parity(a, "before any transparency");
  let v = await alpha();
  if (v.terminal !== 255 || v.header !== 255 || v.sidebar !== 255) fail("with transparency off the whole window is solid", v);
  send({ op: "look", transparency: 30 }); await Bun.sleep(200);
  v = await alpha();
  if (Math.abs(v.terminal - 178) > 4 || v.header !== 255 || v.sidebar !== 255) fail("30% see-through: the terminal's background at about 178 of 255, header and list solid", v);
  await parity(a, "a see-through terminal");
  send({ op: "look", transparency: 0 }); await Bun.sleep(200);
  v = await alpha();
  if (v.terminal !== 255) fail("and solid again", v);
  await close(a);
}

// --- 7. more panes than fit: groups of four, a key walks through them all, the project
// list marks the pane the keyboard is in and browsing it brings a pane on screen
if (part("groups")) {
  const ps = [pane(SH, "100x30"), pane(SH, "100x30"), pane(SH, "100x30"), pane(SH, "100x30"), pane(SH, "100x30")];
  ps.forEach((x, i) => run(x, `echo this is pane ${i + 1}`));
  const node = (i: number) => `t:g/${i + 1}`;
  for (const [i, x] of ps.entries()) {
    send({ op: "open", id: x.id, tab: "g", title: `agent${i + 1}`, node: node(i), color: "#3b82f6", tmux: { session: "mc-p", pane: x.p, window: x.w } });
    await until("opened", (m) => m.id === x.id);
  }
  send({ op: "tree", nodes: [{ id: "p:g", label: "g", children: ps.map((_, i) => ({ id: node(i), label: `agent${i + 1}` })) }] });
  send({ op: "tab", tab: "g", focus: true });
  const state = async () => { send({ op: "list" }); const l = await until("list"); return { on: l.terminals.filter((t: any) => t.tab === "g" && t.onScreen).map((t: any) => t.title).join(), active: l.terminals.find((t: any) => t.active)?.title, selected: l.selected }; };
  const expect = async (what: string, want: { on: string; active?: string; selected?: string }) => {
    let s: any;
    for (let i = 0; i < 40; i++) { s = await state(); if (s.on === want.on && (!want.active || s.active === want.active) && (!want.selected || s.selected === want.selected)) return; await Bun.sleep(60); }
    fail(what, { want, got: s });
  };
  await expect("five panes: the first four on screen", { on: "agent1,agent2,agent3,agent4" });
  for (const x of ps.slice(0, 4)) await until("seeded", (m) => m.id === x.id);
  send({ op: "focus", id: ps[0].id });
  await expect("the list marks the pane with the keyboard", { on: "agent1,agent2,agent3,agent4", active: "agent1", selected: node(0) });
  for (let i = 1; i <= 3; i++) { send({ op: "key", keys: "Ctrl+Shift+Tab" }); await until("keyed"); }
  await expect("three times Ctrl+Shift+Tab: the fourth pane", { on: "agent1,agent2,agent3,agent4", active: "agent4", selected: node(3) });
  send({ op: "key", keys: "Ctrl+Shift+Tab" }); const kk = await until("keyed");
  if (process.env.PARITY_TRACE) for (let k = 0; k < 8; k++) { await Bun.sleep(300); send({ op: "list" }); const l = await until("list"); console.log("after the 4th:", JSON.stringify(kk), JSON.stringify(l.terminals.map((t: any) => [t.title, t.onScreen, t.active])), "focused events:", JSON.stringify(got.filter((x) => x.ev === "focused").map((x) => x.id))); }
  await expect("once more: the fifth pane, alone in the second group", { on: "agent5", active: "agent5", selected: node(4) });
  await parity(ps[4], "a pane of the second group, first shown now");
  send({ op: "key", keys: "Ctrl+Shift+Tab" }); await until("keyed");
  await expect("and round to the first", { on: "agent1,agent2,agent3,agent4", active: "agent1", selected: node(0) });
  for (const x of ps.slice(0, 4)) await parity(x, "the first group, back on screen");
  // browsing the list: the keyboard stays in it, what it points at comes on screen
  send({ op: "sidebar" }); await Bun.sleep(150); // into the list: on the entry of the pane the keyboard was in
  await expect("the list opens on the current pane's entry", { on: "agent1,agent2,agent3,agent4", active: "agent1", selected: node(0) });
  for (let i = 0; i < 4; i++) { send({ op: "key", keys: "Down" }); await until("keyed"); }
  await expect("walking down the list to the fifth agent shows its group", { on: "agent5", active: "agent5", selected: node(4) });
  send({ op: "key", keys: "Up" }); await until("keyed");
  await expect("and up again, the first group", { on: "agent1,agent2,agent3,agent4", active: "agent4", selected: node(3) });
  send({ op: "key", keys: "Escape" }); await until("keyed");
  // a click on an entry (the driver answers a select with a focus): that pane, whatever group
  send({ op: "focus", id: ps[4].id });
  await expect("focusing a pane of another group brings the group", { on: "agent5", active: "agent5", selected: node(4) });
  // one closes: four are left, one group, no strip
  await close(ps[1]); await Bun.sleep(150);
  await expect("four left: all on screen", { on: "agent1,agent3,agent4,agent5" });
  for (const x of [ps[0], ps[2], ps[3], ps[4]]) await close(x);
}

send({ op: "ping" }); await until("pong");
send({ op: "quit" });
if ((await host.exited) !== 0) fail("exit code");
tmux("kill-server");
rmSync(dir, { recursive: true, force: true });
console.log("parity OK");
process.exit(0);
