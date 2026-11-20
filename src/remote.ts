// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// This machine as the far side of `my-claude gui --remote`: an allowed key may run the
// window's driver and tmux clients through `_remote-gate`, nothing else.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, userInfo, hostname } from "node:os";
import { join } from "node:path";
import { CLI } from "./core.ts";
import { CONFIG_DIR } from "./store.ts";

const keysFile = () => process.env.MY_CLAUDE_AUTHORIZED_KEYS ?? join(homedir(), ".ssh", "authorized_keys");
const TAG = "my-claude:";
// restrict: no forwarding of any kind (Unix sockets included), no pty, no agent
const GATE_OPTS = (cmd: string) => `restrict,command="${cmd}"`;
// How the window runs a command over ssh: a login shell, with the per-user install places on
// PATH (a command run over ssh gets neither by itself). host/src/main.cpp sends the same.
export const REMOTE_PATH = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; exec `;

type Entry = { name: string; line: string; key: string };
const entries = (): Entry[] => {
  if (!existsSync(keysFile())) return [];
  return readFileSync(keysFile(), "utf8").split("\n").flatMap((line) => {
    const m = / my-claude:(\S+)\s*$/.exec(line);
    const key = /(ssh-\S+|ecdsa-\S+|sk-\S+) (\S+)/.exec(line);
    return m && key ? [{ name: m[1], line, key: `${key[1]} ${key[2]}` }] : [];
  });
};

// Global IPv6 addresses worth giving out: not deprecated, the stable ones first.
function addresses(): string[] {
  const out = spawnSync("ip", ["-6", "-o", "addr", "show", "scope", "global"], { encoding: "utf8" }).stdout ?? "";
  const rows = out.split("\n").filter((l) => l.includes("inet6") && !l.includes("deprecated")).map((l) => /inet6 ([0-9a-f:]+)\/(\d+)/.exec(l)).filter(Boolean) as RegExpExecArray[];
  const pub = rows.filter((m) => /^[23]/.test(m[1])); // 2000::/3, the internet
  // stable (EUI-64 or a /128 from DHCPv6) before temporary privacy addresses
  return pub.sort((a, b) => Number(b[2] === "128") - Number(a[2] === "128")).map((m) => m[1]);
}

function sshdFacts(): { listening: string[]; passwords: string | null; active: boolean } {
  const active = spawnSync("systemctl", ["is-active", "sshd"], { encoding: "utf8" }).stdout?.trim() === "active";
  const ss = spawnSync("ss", ["-Hltn"], { encoding: "utf8" }).stdout ?? "";
  const listening = ss.split("\n").map((l) => l.trim().split(/\s+/)[3]).filter((a) => a && /:22$/.test(a));
  let cfg = spawnSync("sudo", ["-n", "sshd", "-T"], { encoding: "utf8" }).stdout ?? "";
  if (!cfg) cfg = existsSync("/etc/ssh/sshd_config") ? readFileSync("/etc/ssh/sshd_config", "utf8") : "";
  const pw = /^\s*passwordauthentication\s+(\S+)/im.exec(cfg);
  return { listening, passwords: pw ? pw[1].toLowerCase() : null, active };
}

// Keys allowed by older versions could still forward Unix sockets: they get today's options.
function upgradeKeys(): void {
  if (!existsSync(keysFile())) return;
  const text = readFileSync(keysFile(), "utf8");
  const next = text.replace(/^command="([^"]*_remote-gate)",no-pty,\S* (\S+ \S+ my-claude:\S+)$/gm, (_l, cmd: string, rest: string) => `${GATE_OPTS(cmd)} ${rest}`);
  if (next !== text) writeFileSync(keysFile(), next);
}

export function remoteCmd(args: string[]): number {
  const [sub, ...rest] = args;
  upgradeKeys();
  if (sub === "allow") {
    const [src, ...more] = rest;
    if (!src) { console.error("usage: my-claude remote allow <public key file or 'ssh-ed25519 AAAA…'> [--name N]"); return 2; }
    const text = existsSync(src) ? readFileSync(src, "utf8").trim() : [src, ...more.filter((x, i) => !x.startsWith("--") && more[i - 1] !== "--name")].join(" ").trim();
    const key = /(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+|sk-\S+) ([A-Za-z0-9+/=]+)/.exec(text);
    if (!key) { console.error("my-claude remote allow: that is not an ssh public key"); return 2; }
    const ni = more.indexOf("--name");
    const name = (ni >= 0 ? more[ni + 1] : text.split(/\s+/)[2] ?? "key").replace(/[^A-Za-z0-9@._-]/g, "_");
    if (entries().some((e) => e.key === `${key[1]} ${key[2]}`)) { console.log(`that key is already allowed`); return 0; }
    mkdirSync(join(keysFile(), ".."), { recursive: true, mode: 0o700 });
    const before = existsSync(keysFile()) ? readFileSync(keysFile(), "utf8") : "";
    writeFileSync(keysFile(), (before && !before.endsWith("\n") ? before + "\n" : before) + `${GATE_OPTS(`${CLI} _remote-gate`)} ${key[1]} ${key[2]} ${TAG}${name}\n`);
    chmodSync(keysFile(), 0o600);
    // my-claude's own ssh endpoint (the daemon, config ssh.port) reads a list of its own
    const own = join(CONFIG_DIR, "authorized_keys");
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(own, (existsSync(own) ? readFileSync(own, "utf8") : "") + `${key[1]} ${key[2]} ${TAG}${name}\n`);
    chmodSync(own, 0o600);
    console.log(`allowed ${name}: it can open my-claude's window for this machine, and nothing else over ssh`);
    return remoteCmd(["status"]);
  }
  if (sub === "revoke") {
    const name = rest[0];
    const have = entries();
    if (!name) { console.error("usage: my-claude remote revoke <name>"); return 2; }
    if (!have.some((e) => e.name === name)) { console.error(`no key named ${name} (my-claude remote list)`); return 1; }
    for (const f of [keysFile(), join(CONFIG_DIR, "authorized_keys")]) {
      if (!existsSync(f)) continue;
      writeFileSync(f, readFileSync(f, "utf8").split("\n").filter((l) => !l.endsWith(` ${TAG}${name}`)).join("\n"));
    }
    console.log(`revoked ${name}`);
    return 0;
  }
  if (sub === "list") {
    const have = entries();
    if (!have.length) console.log("no keys allowed (my-claude remote allow <key>)");
    for (const e of have) console.log(`${e.name}  ${e.key.slice(0, 30)}…`);
    return 0;
  }
  if (sub === "key") {
    // this machine's key, to allow on a server: made only when asked and there is none
    const base = join(homedir(), ".ssh", "id_ed25519");
    if (!existsSync(base + ".pub")) {
      if (!rest.includes("--make")) { console.error(`no ${base}.pub: \`my-claude remote key --make\` makes one`); return 1; }
      if (spawnSync("ssh-keygen", ["-t", "ed25519", "-f", base, "-N", "", "-C", `${userInfo().username}@${hostname()}`], { stdio: "inherit" }).status !== 0) return 1;
    }
    console.log(readFileSync(base + ".pub", "utf8").trim());
    return 0;
  }
  if (sub === "status" || !sub) {
    const s = sshdFacts(), addr = addresses(), user = userInfo().username, keys = entries();
    const ok = (b: boolean) => (b ? "ok  " : "!!  ");
    console.log(`${ok(s.active)}sshd ${s.active ? "running" : "not running (sudo systemctl enable --now sshd)"}`);
    console.log(`${ok(s.listening.some((a) => a.startsWith("[")))}sshd on IPv6: ${s.listening.join(", ") || "not listening"}`);
    console.log(`${ok(s.passwords === "no")}password logins ${s.passwords === "no" ? "off" : `${s.passwords ?? "default (on)"}: with sshd open to the world, set PasswordAuthentication no`}`);
    console.log(`${ok(addr.length > 0)}public IPv6: ${addr.join(", ") || "none (no global address)"}`);
    console.log(`${ok(keys.length > 0)}keys allowed: ${keys.map((k) => k.name).join(", ") || "none (my-claude remote allow <key>)"}`);
    if (addr.length) console.log(`\nfrom the other machine:\n  my-claude gui --remote ${user}@${addr[0]}`);
    console.log("(the router must let inbound IPv6 to port 22 through; many block it by default)");
    return 0;
  }
  console.error("usage: my-claude remote [status | allow <key> [--name N] | revoke <name> | list | key [--make]]");
  return 2;
}

// A command line as POSIX shell words (quotes, backslashes), or null when it holds anything
// a shell would act on: the gate takes plain words only.
function words(line: string): string[] | null {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) return null;
      cur = (cur ?? "") + line.slice(i + 1, j);
      i = j;
    } else if (c === "\\" && i + 1 < line.length) cur = (cur ?? "") + line[++i];
    else if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; }
    else if (/[A-Za-z0-9_./:=@%+,-]/.test(c)) cur = (cur ?? "") + c;
    else return null;
  }
  if (cur !== null) out.push(cur);
  return out;
}

const GATED = ["--version", "new", "add", "up", "ls"];
// What an allowed key may run, rebuilt from what was asked (never the text itself): the
// window's driver, the my-claude commands the window runs there, tmux clients for its sessions.
export function gateArgv(asked: string): string[] | null {
  let w = words(asked.trim());
  if (w?.length === 3 && w[0] === "bash" && w[1] === "-lc" && w[2].startsWith(REMOTE_PATH)) w = words(w[2].slice(REMOTE_PATH.length));
  if (!w?.length) return null;
  const [prog, ...args] = w, rest = args.join(" ");
  if (prog === "tmux") {
    const m = /^(-C attach-session|has-session) -t =(mc-[A-Za-z0-9._-]+)$/.exec(rest);
    return m ? ["tmux", ...m[1].split(" "), "-t", `=${m[2]}`] : null;
  }
  if (!/(^|\/)my-claude$/.test(prog)) return null;
  if (rest === "_gui --stdio") return [CLI, "_gui", "--stdio"];
  return GATED.includes(args[0] ?? "") ? [CLI, ...args] : null;
}

// The forced command of an allowed key (sshd puts what was asked in SSH_ORIGINAL_COMMAND).
export function remoteGate(): number {
  const asked = process.env.SSH_ORIGINAL_COMMAND ?? "";
  const argv = gateArgv(asked);
  if (!argv) {
    console.error(`my-claude: this key opens my-claude's window and nothing else (asked for: ${asked.slice(0, 80) || "a shell"})`);
    return 1;
  }
  return spawnSync(argv[0], argv.slice(1), { stdio: "inherit" }).status ?? 1;
}
