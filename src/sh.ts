// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Process helpers: awaitable ones (sh, shOk, pause) for whatever serves a UI and must not
// block; blocking ones (out, ok, run, sleep) for a pane's foreground job and for profiles.
import { execFileSync, spawnSync, type SpawnSyncOptions } from "node:child_process";

// A command's stdout, awaited. Throws on a non-zero exit (or a missing program) unless
// `ok`, which turns any failure into "".
export async function sh(cmd: string, args: string[], opts: { cwd?: string; ok?: boolean } = {}): Promise<string> {
  let stdout = "", stderr = "", code: number;
  try {
    const proc = Bun.spawn([cmd, ...args], { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  } catch (e: any) {
    if (opts.ok) return "";
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${e?.message ?? e}`);
  }
  if (code === 0) return stdout.trimEnd();
  if (opts.ok) return "";
  // Never echo the full command line: pane environments carry tokens.
  throw new Error(`${cmd} ${args[0] ?? ""} failed: ${(stderr || `exit ${code}`).trim().split("\n").pop()}`);
}

// Did it exit 0? Awaited; a missing program is a no.
export async function shOk(cmd: string, args: string[]): Promise<boolean> {
  try {
    return (await Bun.spawn([cmd, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
}

export const pause = (ms: number): Promise<void> => Bun.sleep(ms);

export function out(cmd: string, args: string[], opts: { cwd?: string; ok?: boolean } = {}): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd }).trimEnd();
  } catch (e: any) {
    if (opts.ok) return "";
    // Never echo the full command line: pane environments carry tokens.
    const detail = (e?.stderr?.toString?.() || e?.message || "").trim().split("\n").pop();
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${detail}`);
  }
}

export function ok(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
}

// Foreground child sharing our terminal; returns its exit status.
export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): number {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return r.status ?? 1;
}

// POSIX single-quote quoting, safe for any byte sequence.
export function shq(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number): void {
  Bun.sleepSync(ms);
}

// A login shell by default, so it has what a terminal opened by hand has (shell.login: false
// for a plain one); interactive where a command follows, or ~/.bashrc returns at once.
export const loginShell = (login: boolean): { shell: string; args: string[]; flags: string } => ({
  shell: process.env.SHELL || "bash", args: login ? ["-l"] : [], flags: login ? "-lic" : "-ic",
});

// Started by a service (the daemon's tmux server) or from the desktop, a process lacks what an
// interactive login shell exports (tokens, PATH): take it, keeping what names this run.
export function adoptShellEnv(login = true, log: (m: string) => void = () => {}): void {
  if (process.env.MY_CLAUDE_NO_SHELL_ENV) return;
  const keep = /^(MC_TERM_|MY_CLAUDE_|TMUX|XDG_|DISPLAY$|WAYLAND_DISPLAY$|DBUS_|QT_|HOME$|USER$|LOGNAME$|SHLVL$|PWD$|OLDPWD$|_$)/;
  try {
    const r = Bun.spawnSync([process.env.SHELL || "bash", login ? "-lic" : "-ic", 'printf "\\0MCENV\\0"; env -0'], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    const all = r.stdout.toString("utf8");
    const at = all.indexOf("\0MCENV\0");
    if (at < 0) return;
    let n = 0;
    for (const kv of all.slice(at + 7).split("\0")) {
      const i = kv.indexOf("=");
      if (i <= 0) continue;
      const k = kv.slice(0, i);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || keep.test(k)) continue;
      if (process.env[k] !== kv.slice(i + 1)) { process.env[k] = kv.slice(i + 1); n++; }
    }
    log(`took ${n} variables from the interactive shell environment`);
  } catch (e) {
    log(`shell environment not read: ${e instanceof Error ? e.message : String(e)}`);
  }
}
