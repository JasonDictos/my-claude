// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
import { connect } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
const env = process.env as Record<string, string>;
const fail = (m: string, extra?: unknown): never => { console.error("FAIL:", m, extra === undefined ? "" : "\n" + (typeof extra === "string" ? extra : JSON.stringify(extra, null, 1))); process.exit(1); };
setTimeout(() => fail("timeout"), 90_000);
for (let i = 0; i < 100 && !existsSync(env.R_SOCK); i++) await Bun.sleep(50);
const c = connect(env.R_SOCK);
const got: any[] = []; let buf = "";
c.on("data", (d) => { buf += d; for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
await new Promise((r, j) => { c.on("connect", r); c.on("error", j); });
const send = (o: object) => c.write(JSON.stringify(o) + "\n");
const until = async (ev: string, pred: (m: any) => boolean = () => true, what = ev) => { for (let i = 0; i < 1500; i++) { const k = got.findIndex((x) => x.ev === ev && pred(x)); if (k >= 0) return got.splice(k, 1)[0]; await Bun.sleep(20); } return fail(`no ${what}`, got.slice(-5)); };
const list = async () => { send({ op: "list" }); return until("list"); };
const shows = async (what: string, pred: (l: any) => boolean, ms = 40000) => { let l: any; for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(200)) { l = await list(); if (pred(l)) return l; } return fail(`window never showed: ${what}`, l); };

// the project from "over there": a tab, both peers, each a native pane that is live
const l = await shows("the far project's two panes, natively", (x) => x.tabs.join() === "far" && x.terminals.length === 2 && x.terminals.every((t: any) => t.native && t.live) && x.driver);
if (l.terminals.map((t: any) => t.title).sort().join() !== "r1,r2") fail("both peers", l.terminals);
// typing goes there and comes back
const t = l.terminals[0];
send({ op: "send", id: t.id, text: "typed-from-afar" });
for (let i = 0; ; i++) {
  send({ op: "screen", id: t.id }); const s = await until("screen", (m) => m.id === t.id);
  if (s.text.includes("typed-from-afar")) break;
  if (i > 60) fail("what is typed should come back from the pane", s.text);
  await Bun.sleep(100);
}
// and all of it went through "ssh": the driver on its stdio, a tmux control client
const log = readFileSync(env.FAKE_SSH_LOG, "utf8");
if (!/\S+: .*_gui --stdio'?$/m.test(log)) fail("the driver should have been started through ssh", log);
if (!/\S+: (env TMUX_TMPDIR=\S+ )?tmux -C attach-session -t =mc-far/.test(log)) fail("tmux should have been reached through ssh", log);
// the connection drops (the driver's ssh dies): the window starts it again, the panes are still there
const sshPid = Number(readFileSync(env.FAKE_SSH_PIDFILE, "utf8").trim());
if (!sshPid) fail("no driver connection to drop");
process.kill(sshPid, "SIGTERM");
await shows("the driver back after the connection dropped", (x) => x.driver && x.terminals.length === 2 && x.terminals.every((y: any) => y.live), 30000);
if (Bun.spawnSync(["tmux", "list-windows", "-t", "=mc-far", "-F", "#{window_id}"], { env }).stdout.toString().trim().split("\n").length !== 2) fail("the project should have stayed one pane per window through the drop");
send({ op: "quit" });
await Bun.sleep(1500);
console.log("remote OK");
process.exit(0);
