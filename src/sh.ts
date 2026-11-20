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
