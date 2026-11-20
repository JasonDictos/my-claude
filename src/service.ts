// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// `my-claude service`: the daemon as a systemd user service (the RPM ships the unit).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI } from "./core.ts";
import { daemonSettings as config, saveConfig } from "./store.ts";

const UNIT = "my-claude.service";
const unitPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", UNIT);
const ctl = (...a: string[]) => spawnSync("systemctl", ["--user", ...a], { encoding: "utf8" });

export function serviceCmd(args: string[]): number {
  const sub = args[0] ?? "status";
  if (sub === "install") {
    // the RPM ships the unit itself: only turn it on
    if (existsSync(`/usr/lib/systemd/user/${UNIT}`)) {
      saveConfig({ daemon: { autoRestart: true }, autoRestart: null });
      const r = ctl("enable", "--now", UNIT);
      if (r.status !== 0) { console.error(r.stderr.trim()); return 1; }
      return serviceCmd(["status"]);
    }
    mkdirSync(join(unitPath(), ".."), { recursive: true });
    writeFileSync(unitPath(), `[Unit]
Description=my-claude daemon: owns project state, brings projects back up, optional ssh endpoint
After=default.target

[Service]
Type=simple
# a login shell: PATH, tokens and whatever else the profiles need, as in a terminal
ExecStart=/bin/bash -lc 'exec "${CLI}" daemon'
Restart=always
RestartSec=10
# only the loop is stopped; tmux and the projects run in a scope of their own
KillMode=process

[Install]
WantedBy=default.target
`);
    saveConfig({ daemon: { autoRestart: true }, autoRestart: null });
    ctl("daemon-reload");
    const r = ctl("enable", "--now", UNIT);
    if (r.status !== 0) { console.error(r.stderr.trim()); return 1; }
    console.log("auto-restart on: projects that were up come back by themselves (my-claude down keeps one down)");
    return serviceCmd(["status"]);
  }
  if (sub === "uninstall") {
    ctl("disable", "--now", UNIT);
    rmSync(unitPath(), { force: true });
    ctl("daemon-reload");
    saveConfig({ daemon: { autoRestart: false }, autoRestart: null });
    console.log("auto-restart off; the service is removed");
    return 0;
  }
  if (sub === "status") {
    const active = ctl("is-active", UNIT).stdout.trim();
    const have = existsSync(unitPath()) || existsSync(`/usr/lib/systemd/user/${UNIT}`);
    console.log(`auto-restart: ${config().autoRestart ? "on" : "off"} · service ${have ? active : "not installed"}`);
    if (!have) console.log("  my-claude service install   to turn it on");
    return 0;
  }
  console.error("usage: my-claude service [status | install | uninstall]");
  return 2;
}
