// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// The ssh gate (src/remote.ts) against what the window really sends, and against abuse.
import { gateArgv, REMOTE_PATH } from "../src/remote.ts";
import { CLI } from "../src/core.ts";
const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
// exactly what gui.ts onMachine sends
const onMachine = (args: string[]) => `bash -lc ${q(`${REMOTE_PATH}${["my-claude", ...args].map(q).join(" ")}`)}`;
// exactly what main.cpp sends for the driver
const driver = `bash -lc 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; exec my-claude _gui --stdio'`;
const cases: [string, string[] | null][] = [
  [driver, [CLI, "_gui", "--stdio"]],
  [onMachine(["--version"]), [CLI, "--version"]],
  [onMachine(["new", "demo", "--goal", "it's a goal; with $(stuff) in it", "--color", "blue"]), [CLI, "new", "demo", "--goal", "it's a goal; with $(stuff) in it", "--color", "blue"]],
  [onMachine(["add", "demo", "~/src/api", "acme/billing"]), [CLI, "add", "demo", "~/src/api", "acme/billing"]],
  [onMachine(["up", "demo", "--no-attach"]), [CLI, "up", "demo", "--no-attach"]],
  ["tmux -C attach-session -t =mc-far", ["tmux", "-C", "attach-session", "-t", "=mc-far"]],
  ["tmux has-session -t =mc-far", ["tmux", "has-session", "-t", "=mc-far"]],
  ["tmux -C attach-session -t =my-claude-consoles", ["tmux", "-C", "attach-session", "-t", "=my-claude-consoles"]],
  ["tmux -C attach-session -t =my-claude-consoles-x", null],
  [`bash -lc 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; exec my-claude _gui --stdio; rm -rf ~'`, null],
  [onMachine(["delete", "demo"]), null],
  [onMachine(["_remote-gate"]), null],
  ["rm -rf /", null],
  ["bash -c 'my-claude _gui --stdio'", null],
  ["tmux kill-server", null],
  ["tmux -C attach-session -t =mc-x; reboot", null],
  ["my-claude add x $(id)", null],
  ["", null],
  ["/usr/bin/my-claude _gui --stdio", [CLI, "_gui", "--stdio"]],
];
let bad = 0;
for (const [cmd, want] of cases) {
  const got = gateArgv(cmd);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { bad++; console.log("FAIL", JSON.stringify(cmd).slice(0, 120), "->", JSON.stringify(got)); }
}
console.log(bad ? `${bad} failed` : `gate OK (${cases.length} cases)`);
process.exit(bad ? 1 : 0);
