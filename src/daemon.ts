// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// The daemon owns the projects' state: what should be up and is, bringing back what fell over,
// up/down for whoever asks (daemon.sock, JSON lines); with daemon.ssh.port, an ssh endpoint.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import * as core from "./core.ts";
import { gateArgv } from "./remote.ts";
import { CONFIG_DIR, ROOT, daemonSettings as config, listProjects, load } from "./store.ts";
import * as tmux from "./tmux.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
export const daemonSocket = () => join(process.env.XDG_RUNTIME_DIR ?? `/tmp/my-claude-${process.getuid?.()}`, "my-claude", "daemon.sock");

type ProjState = { name: string; up: boolean; want: boolean; state: string; peers: number; busy?: string };

// ---- talking to a running daemon (the CLI uses this)
// null: no daemon, or one serving other projects (another MY_CLAUDE_ROOT: a test, a sandbox)
export function daemonCall(msg: object, timeoutMs = 120_000): Promise<any | null> {
  msg = { ...msg, root: ROOT };
  return new Promise((resolve) => {
    const c = connect(daemonSocket());
    let buf = "";
    const t = setTimeout(() => { c.destroy(); resolve(null); }, timeoutMs);
    c.on("error", () => { clearTimeout(t); resolve(null); });
    c.on("connect", () => c.write(JSON.stringify(msg) + "\n"));
    c.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(t);
      c.end();
      try { const r = JSON.parse(buf.slice(0, nl)); resolve(r?.ev === "not-mine" ? null : r); } catch { resolve(null); }
    });
  });
}

class Daemon {
  private states = new Map<string, ProjState>();
  private chains = new Map<string, Promise<unknown>>();
  private subs = new Set<Socket>();

  async run(): Promise<number> {
    const sock = daemonSocket();
    mkdirSync(join(sock, ".."), { recursive: true });
    if (await daemonCall({ op: "ping" }, 1500)) { console.error("my-claude daemon: already running"); return 1; }
    rmSync(sock, { force: true });
    void core.sweepDeleting();
    const srv = createServer((c) => this.client(c));
    await new Promise<void>((r) => srv.listen(sock, r));
    log(`daemon up (pid ${process.pid}) on ${sock}; auto-restart ${this.autoRestart() ? "on" : "off"}`);
    const port = Number(config().ssh?.port ?? 0);
    if (port) await this.ssh(port).catch((e) => log(`ssh: not started: ${e instanceof Error ? e.message : e}`));
    for (;;) {
      await this.look().catch((e) => log(`look failed: ${e instanceof Error ? e.message : e}`));
      await core.pauseFor(4000);
    }
  }

  private autoRestart = () => config().autoRestart !== false;

  // one change at a time per project, whoever asked for it
  private work<T>(name: string, what: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(name) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const s = this.states.get(name);
      if (s) { s.busy = what; this.publish(); }
      try { return await fn(); } finally { if (s) delete s.busy; await this.look(); }
    });
    this.chains.set(name, next.catch(() => {}));
    return next;
  }

  private async look(): Promise<void> {
    const seen = new Set<string>();
    let changed = false;
    for (const { name } of listProjects()) {
      seen.add(name);
      const p = load(name);
      const up = await tmux.sessionUp(name);
      const next: ProjState = { name, up, want: !!p.running, state: up ? "up" : p.running ? "down (restarting)" : "down", peers: p.peers.length, busy: this.states.get(name)?.busy };
      const before = this.states.get(name);
      if (!before || before.up !== next.up || before.want !== next.want) changed = true;
      this.states.set(name, next);
      if (!up && p.running && p.peers.length && this.autoRestart() && !this.chains.has(name + ":restart")) {
        const key = name + ":restart";
        this.chains.set(key, this.work(name, "restarting", async () => {
          log(`${name} is down and should be up: bringing it back`);
          for (const r of await core.up(name)) if (r.action !== "live") log(`  ${r.repo}: ${r.action}${r.detail ? ` (${r.detail})` : ""}`);
          await core.syncGroupNow(name).catch(() => {});
        }).catch((e) => log(`${name}: restart failed: ${e instanceof Error ? e.message : e}`)).finally(() => this.chains.delete(key)));
      }
    }
    for (const n of [...this.states.keys()]) if (!seen.has(n)) { this.states.delete(n); changed = true; }
    if (changed) this.publish();
  }

  private status() { return { ev: "status", autoRestart: this.autoRestart(), ssh: Number(config().ssh?.port ?? 0) || null, projects: [...this.states.values()] }; }
  private publish(): void { const m = JSON.stringify(this.status()) + "\n"; for (const s of this.subs) s.write(m); }

  private client(c: Socket): void {
    let buf = "";
    c.on("error", () => {});
    c.on("close", () => this.subs.delete(c));
    c.on("data", (d) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        void this.request(m).then((r) => { if (!c.destroyed) c.write(JSON.stringify(r) + "\n"); });
        if (m.op === "subscribe") this.subs.add(c);
      }
    });
  }

  private async request(m: any): Promise<object> {
    const err = (e: unknown) => ({ ev: "error", error: e instanceof Error ? e.message : String(e) });
    if (m.root && m.root !== ROOT) return { ev: "not-mine", root: ROOT };
    try {
      switch (m.op) {
        case "ping": return { ev: "pong", pid: process.pid };
        case "status": case "subscribe": return this.status();
        case "up": { const r = await this.work(m.project, "starting", () => core.up(m.project, { takeover: !!m.takeover })); await core.syncGroupNow(m.project).catch(() => {}); return { ev: "up", project: m.project, report: r }; }
        case "down": return { ev: "down", project: m.project, done: await this.work(m.project, "stopping", () => core.down(m.project)) };
        default: return { ev: "error", error: `unknown op ${m.op}` };
      }
    } catch (e) { return err(e); }
  }

  // ---- the SSH endpoint
  private async ssh(port: number): Promise<void> {
    const { Server, utils } = await import("ssh2");
    const hostKey = join(CONFIG_DIR, "ssh_host_ed25519_key");
    if (!existsSync(hostKey)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
      if (spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "my-claude daemon", "-f", hostKey]).status !== 0) throw new Error("ssh-keygen failed");
    }
    const keysFile = join(CONFIG_DIR, "authorized_keys");
    const allowed = () => (existsSync(keysFile) ? readFileSync(keysFile, "utf8") : "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
      .map((l) => utils.parseKey(l)).filter((k): k is any => !(k instanceof Error));
    const srv = new Server({ hostKeys: [readFileSync(hostKey)] }, (client: any, info: any) => {
      const who = `${info.ip}`;
      client.on("authentication", (ctx: any) => {
        if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
        const key = allowed().find((k) => k.type === ctx.key.algo && Buffer.compare(k.getPublicSSH(), ctx.key.data) === 0);
        if (!key) return ctx.reject(["publickey"]);
        if (ctx.signature && !key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
        ctx.accept();
      });
      client.on("ready", () => log(`ssh: ${who} logged in`));
      client.on("error", () => {});
      // no tunnels of any kind
      client.on("request", (_accept: any, reject: any) => reject?.());
      client.on("tcpip", (_a: any, reject: any) => reject());
      client.on("openssh.streamlocal", (_a: any, reject: any) => reject());
      client.on("session", (accept: any) => {
        const session = accept();
        session.on("pty", (_a: any, reject: any) => reject?.());
        session.on("shell", (_a: any, reject: any) => reject());
        session.on("exec", (acc: any, _rej: any, info: any) => {
          const ch = acc();
          const argv = this.gate(String(info.command));
          if (!argv) {
            ch.stderr.write(`my-claude: this endpoint opens my-claude's window and nothing else (asked for: ${String(info.command).slice(0, 80)})\n`);
            ch.exit(1); ch.end(); return;
          }
          if (argv[0] === "@status") { ch.write(JSON.stringify(this.status()) + "\n"); ch.exit(0); ch.end(); return; }
          log(`ssh: ${who}: ${argv.join(" ")}`);
          const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: process.env });
          ch.pipe(child.stdin);
          child.stdout.pipe(ch, { end: false });
          child.stderr.pipe(ch.stderr);
          child.on("exit", (code) => { try { ch.exit(code ?? 1); ch.end(); } catch {} });
          child.on("error", () => { try { ch.exit(127); ch.end(); } catch {} });
          ch.on("close", () => { if (child.exitCode === null) child.kill("SIGTERM"); });
        });
      });
    });
    const host = String(config().ssh?.listen ?? "::");
    await new Promise<void>((r, j) => { srv.on("error", j); srv.listen(port, host, () => r()); });
    log(`ssh: listening on [${host}]:${port} (keys: ${keysFile})`);
  }

  // sshd's gate, plus a status line of our own
  private gate(cmd: string): string[] | null {
    return /^(my-claude )?status$/.test(cmd.trim()) ? ["@status"] : gateArgv(cmd);
  }
}

export const runDaemon = () => new Daemon().run();
