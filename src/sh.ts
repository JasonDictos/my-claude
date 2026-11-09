// Thin process helpers. Everything that leaves the process goes through here.
import { execFileSync, spawnSync, type SpawnSyncOptions } from "node:child_process";

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
