// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// my-claude deploy user@host: compiled here and sent over ssh into ~/.local there (no root,
// nothing built there), with the static window when there is one and the daemon's service.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./store.ts";

const version = (): string => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

export async function deploy(args: string[], log: (s: string) => void = console.log): Promise<number> {
  const dest0 = args.find((a) => !a.startsWith("-"));
  if (!dest0) { console.error("usage: my-claude deploy user@host[:port] [--identity key] [--jump host] [--no-service]"); return 2; }
  const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  let dest = dest0, port = opt("--port") ?? "";
  const hp = /^(.*?)\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(dest) ?? /^([^:]+):(\d+)$/.exec(dest);
  if (hp) { const two = hp.length === 4; dest = two ? hp[1] + hp[2] : hp[1]; port = port || (two ? hp[3] ?? "" : hp[2]); }
  const key = opt("--identity"), jump = opt("--jump");
  const sshOpts = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...(port ? ["-p", port] : []), ...(key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : []), ...(jump ? ["-J", jump] : [])];
  const ssh = (cmd: string) => Bun.spawnSync(["ssh", ...sshOpts, dest, cmd], { stdout: "pipe", stderr: "pipe" });

  // 1. reachable, and what is there already
  const probe = ssh('uname -m; for t in tmux git claude; do command -v "$t" >/dev/null 2>&1 && echo "have $t" || echo "lack $t"; done');
  if (probe.exitCode !== 0) { console.error(`cannot reach ${dest0}: ${probe.stderr.toString().trim().split("\n").pop()}`); return 1; }
  const facts = probe.stdout.toString();
  if (!/^x86_64$/m.test(facts)) { console.error(`${dest0} is ${facts.split("\n")[0]}: only x86_64 for now`); return 1; }
  const lacking = [...facts.matchAll(/^lack (\S+)$/gm)].map((m) => m[1]);
  if (lacking.includes("tmux")) { console.error(`${dest0} has no tmux: install it there first (my-claude runs every project in tmux)`); return 1; }

  // 2. the files, staged here
  const stage = mkdtempSync(join(tmpdir(), "my-claude-deploy-"));
  try {
    log(`compiling my-claude ${version()} …`);
    const build = Bun.spawnSync([process.execPath, "build", "--compile", "--target=bun-linux-x64", join(ROOT, "src", "cli.ts"), "--outfile", join(stage, "my-claude")], { cwd: ROOT, stdout: "ignore", stderr: "pipe" });
    if (build.exitCode !== 0) { console.error(`compile failed: ${build.stderr.toString().trim().split("\n").pop()}`); return 1; }
    const wrapper = readFileSync(join(ROOT, "packaging", "my-claude.sh"), "utf8")
      .replaceAll("@LIBDIR@", "$HOME/.local/lib").replaceAll("@DATADIR@", "$HOME/.local/share").replaceAll("@VERSION@", version());
    writeFileSync(join(stage, "my-claude.sh"), wrapper);
    chmodSync(join(stage, "my-claude.sh"), 0o755);
    const window = [join(ROOT, "dist", "static", "mc-term")].find((p) => existsSync(p));
    if (window) copyFileSync(window, join(stage, "mc-term"));
    mkdirSync(join(stage, "icons"));
    for (const n of [16, 22, 24, 32, 48, 64, 128, 256, 512]) copyFileSync(join(ROOT, "host", "icons", `mc-term-${n}.png`), join(stage, "icons", `mc-term-${n}.png`));
    copyFileSync(join(ROOT, "host", "icons", "mc-term.svg"), join(stage, "icons", "mc-term.svg"));
    copyFileSync(join(ROOT, "packaging", "my-claude-user.service"), join(stage, "my-claude.service"));

    // 3. over, as one tar stream, unpacked into place
    log(`copying to ${dest0} …`);
    const tar = Bun.spawn(["tar", "-C", stage, "-cz", "."], { stdout: "pipe" });
    const unpack = Bun.spawn(["ssh", ...sshOpts, dest, `set -e; d=$(mktemp -d); tar -C "$d" -xz
      mkdir -p ~/.local/lib/my-claude ~/.local/bin ~/.local/share/my-claude ~/.config/systemd/user
      install -m755 "$d/my-claude" ~/.local/lib/my-claude/my-claude
      install -m755 "$d/my-claude.sh" ~/.local/bin/my-claude
      [ -f "$d/mc-term" ] && install -m755 "$d/mc-term" ~/.local/bin/mc-term
      rm -rf ~/.local/share/my-claude/icons; cp -r "$d/icons" ~/.local/share/my-claude/icons
      sed 's#/usr/bin/my-claude#'"$HOME"'/.local/bin/my-claude#' "$d/my-claude.service" > ~/.config/systemd/user/my-claude.service
      rm -rf "$d"`], { stdin: tar.stdout, stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(unpack.stderr).text(), unpack.exited]);
    if (code !== 0) { console.error(`copy failed: ${err.trim().split("\n").pop()}`); return 1; }

    // 4. it answers, and its daemon runs
    const check = ssh('export PATH="$HOME/.local/bin:$PATH"; my-claude --version');
    if (check.exitCode !== 0) { console.error(`installed, but it does not run there: ${check.stderr.toString().trim().split("\n").pop()}`); return 1; }
    log(`${dest0}: ${check.stdout.toString().trim()}`);
    if (!args.includes("--no-service")) {
      const svc = ssh('export PATH="$HOME/.local/bin:$PATH"; systemctl --user daemon-reload && my-claude service install >/dev/null && systemctl --user is-active my-claude.service');
      log(`${dest0}: daemon ${svc.stdout.toString().trim() || "not started (" + svc.stderr.toString().trim().split("\n").pop() + ")"}`);
    }
    if (!window) log("(no self-contained window to send: packaging/static/build.sh makes one; a window here can show its projects anyway)");
    if (lacking.length) log(`${dest0} still lacks: ${lacking.join(", ")} (claude is needed to run peers there)`);
    return 0;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
