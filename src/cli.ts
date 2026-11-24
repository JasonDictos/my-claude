#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// my-claude: a project is one long-lived Claude session per repo, one tmux session per project,
// every conversation resumable by id. No arguments: the menu.
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as core from "./core.ts";
import * as tmux from "./tmux.ts";
import { hostSend } from "./host.ts";
import { ROOT, UsageError, load, type Role } from "./store.ts";

const USAGE = `usage: my-claude [cui] [--remote user@host] <command> [args]   (no command: the menu)
  new    <project> [--goal TEXT] [--shared] [--profile P] [--color blue|orange|green|purple|red|yellow|teal|pink] [--ticket KEY]
  add    <project> <spec> [<spec>...] [--model M] [--takeover]
         spec: <path> | <repo> | <org>/<repo> | <git url> | <PR url>, each with optional --branch B --name N --port P (repeatable;
         P is PORT, HOST:CONTAINER or IP:HOST:CONTAINER, forwarded into its container)
         a path is symlinked into projects/<project>/; anything else is cloned there fresh
  rm     <project> <repo> [--force]      its clone is deleted (a linked repo only unlinked); readd: same path and conversation
  readd  <project> [<repo>]              re-add a removed repo (no repo: list what was removed)
  up     <project> [--no-attach] [--takeover]   --takeover: a conversation open in a Claude started elsewhere moves here
  attach <project> [<repo>]
  down   <project>
  ls     [--json]
  status <project> [--json]
  lead   <project> <repo> [GOAL TEXT]    set the lead (and the goal), brief everyone via claude-peers
  brief  <project>                       resend the briefs
  ticket <project> [KEY|-]               set (or clear) the tracker ticket the project is for; briefed to every peer
  color  <project> <color>
  set    <project> <repo> [--role peer] [--model M|default] [--session <id or prefix>]
  index  <project> [<repo>]              rebuild the ctags symbol index (automatic at launch)
  restart  <project> <repo>              stop the peer's claude and start it again in the same pane, same conversation
  takeover <project> <repo>              kill the stranger occupying the repo, launch the peer
  delete <project> [--force]             down + its clones deleted, the record to .trash/ for undelete (conversations kept)
  undelete [<project>]                   bring a deleted project back; no project: list .trash/
  layout <project> [grid|solo]           grid: tiled tmux windows and the side panel (the terminal UI);
                                         solo: one pane per window, as the window shows it

  gui    [--remote user@host [--port N] [--identity F] [--jump H]]   the window, for this machine or that one
  gui    --remote … --save                connect that machine to this machine's window from now on
  gui    --remote … --pin [--name N] | --unpin N  save that machine, with a "my-claude <name>" launcher
  gui    --connect <name>                this machine's window, with that saved machine's projects in it
  gui    --toggle | --build              show or hide the window (Ctrl+Alt+T) / rebuild it
  --install | --uninstall                the window in the desktop's application menu, with its show/hide key
  deploy user@host[:port] [--identity F] [--jump H] [--no-service]   put my-claude on that machine (~/.local, no root)
  daemon                                 owns the projects' state, brings back what fell over, optional ssh endpoint
  service [install|uninstall|status]     the daemon as a systemd user service
  remote [status]                        this machine as the far side: sshd, public IPv6, allowed keys
  remote allow <key> [--name N] | revoke <name> | list   which keys may open the window for this machine
  remote key [--make]                    this machine's public key, to allow on a server
  --version

  from inside a project's tmux session (bound to its keys):
  next | prev                            the next/previous project session (prefix+Tab / prefix+Shift+Tab)
  panel                                  focus or open the side panel (prefix+\`)
  shell-here [--host]                    a shell in the peer's environment (prefix+h), or on the host (prefix+H)
  shell-min                              minimise a floating shell to a strip at the bottom (prefix+m)
  chat                                   a floating chat with the project's peers (prefix+c)

  mcp                                    the MCP server every peer gets (start_project, add_repos, …)
  build                                  compile dist/my-claude, what dev containers run (automatic at project start)
  keepalive [--once]                     bring back what is down and was not brought down on purpose (the daemon does this)`;

// Inside one of the app's views the app manages windows: a key's request goes to it (true),
// not to tmux (false: not in a view).
const toHost = async (msg: object): Promise<boolean> => {
  const v = await tmux.clientView();
  if (!v?.sock) return false;
  await hostSend(msg, v.sock);
  return true;
};
// Something changed under a view (a shell opened, a pane closed): have the app look now
// instead of at its next poll, and focus the new pane once it shows.
const nudge = async (name?: string | null, pane?: string | null): Promise<number> => {
  await toHost({ op: "emit", event: { ev: "nudge", focus: name && pane ? `${name}/${pane}` : null } });
  return 0;
};

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

// Tiny option parser: flags with values, booleans, positionals.
function parse(argv: string[], valued: string[], bools: string[] = []) {
  const opts: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) opts[a.slice(2)] = argv[++i] ?? usage();
    else if (bools.includes(a)) opts[a.slice(2)] = true;
    else if (a.startsWith("--")) usage();
    else pos.push(a);
  }
  return { opts, pos };
}

const ago = (epoch: number) => {
  if (!epoch) return "never";
  const s = Math.floor(Date.now() / 1000 - epoch);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (c ?? "").padEnd(w[i])).join("  ").trimEnd()).join("\n");
}

// user@host:port, user@[v6]:port, or plain: ssh itself takes no "host:port"
export function splitDest(d: string): { host: string; port: string } {
  let m = /^(.*?)\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(d);
  if (m) return { host: m[1] + m[2], port: m[3] ?? "" };
  m = /^([^:]+):(\d+)$/.exec(d);
  return m ? { host: m[1], port: m[2] } : { host: d, port: "" };
}

async function main(argv: string[]): Promise<number> {
  // Two faces: `cui` (the terminal UI, the default: the word may be left out) and `gui`
  // (the window). Each takes --remote user@host the same way, before its command.
  if (argv[0] === "cui") argv = argv.slice(1);
  // [cui] --remote user@host <command>: run it there over ssh, in this terminal (gui has its own
  // --remote: the window stays here)
  // my-claude --remote host --install-shortcut: the launcher is the window's business
  if (argv[0] === "--remote" && argv.includes("--install-shortcut")) return (await import("./gui.ts")).launch(argv);
  if (argv[0] === "--remote") {
    const dest = argv[1];
    if (!dest) { console.error("usage: my-claude --remote user@host [command...]"); return 2; }
    const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
    const remoteCmd = ["my-claude", ...argv.slice(2)].map(q).join(" ");
    // a login shell there finds my-claude wherever its installer put it
    const there = `bash -lc ${q(`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; exec ${remoteCmd}`)}`;
    const { host, port } = splitDest(dest);
    return spawnSync("ssh", ["-t", ...(port ? ["-p", port] : []), host, there], { stdio: "inherit" }).status ?? 1;
  }
  const [cmd, ...rest] = argv;
  if (!cmd) return menuLoop();
  if (cmd === "--version" || cmd === "version") { console.log(`my-claude ${(await import("../package.json")).version}`); return 0; }
  if (cmd === "--install" || cmd === "install") return (await import("./gui.ts")).install();
  if (cmd === "--uninstall" || cmd === "uninstall") return (await import("./gui.ts")).uninstall();
  switch (cmd) {
    case "new": {
      const { opts, pos } = parse(rest, ["--goal", "--profile", "--color", "--ticket"], ["--shared"]);
      if (pos.length !== 1) usage();
      const p = core.newProject(pos[0], { goal: opts.goal as string, shared: !!opts.shared, profile: opts.profile as string, color: opts.color as string, ticket: opts.ticket as string });
      console.log(`created ${p.name} (${p.mode}, profile ${p.profile})`);
      return 0;
    }
    case "add": {
      // --role/--model apply to the first repo; --branch/--name travel with the spec they follow.
      const [project, ...specWords] = rest;
      if (!project) usage();
      const words: string[] = [];
      const o: { model?: string | null; takeover?: boolean } = {};
      for (let i = 0; i < specWords.length; i++) {
        if (specWords[i] === "--model") o.model = specWords[++i] ?? usage();
        else if (specWords[i] === "--takeover") o.takeover = true;
        else words.push(specWords[i]);
      }
      if (!words.length) usage();
      return core.addRepos(project, words.join(" "), { ...o, log: console.log })
        .then(async (peers) => { for (const peer of peers) console.log(`added ${peer.repo} (${peer.role}) to ${project} at ${peer.path}`); await core.syncGroupNow(project); return 0; });
    }
    case "rm": {
      const { opts, pos } = parse(rest, [], ["--force"]);
      if (pos.length !== 2) usage();
      const note = await core.rmPeer(pos[0], pos[1], { force: !!opts.force });
      console.log(`removed ${pos[1]} from ${pos[0]} (conversation kept on disk${note ? "; " + note : ""})`);
      return core.syncGroupNow(pos[0]).then(() => 0);
    }
    case "up": {
      const { opts, pos } = parse(rest, [], ["--no-attach", "--takeover"]);
      if (pos.length !== 1) usage();
      // the daemon, when it runs, is the one that changes projects
      const takeover = !!opts.takeover;
      const viaDaemon = await (await import("./daemon.ts")).daemonCall({ op: "up", project: pos[0], takeover }, 600_000);
      if (viaDaemon?.ev === "error") { console.error(`my-claude: ${viaDaemon.error}`); return 1; }
      for (const r of viaDaemon?.report ?? await core.up(pos[0], { takeover })) {
        console.log(r.action === "skipped" ? `${r.repo}: SKIP, occupied by a session my-claude did not start:\n   ${r.detail}` : `${r.repo}: ${r.action}`);
      }
      await core.syncGroupNow(pos[0]);
      return opts["no-attach"] ? 0 : core.attach(pos[0]);
    }
    case "attach":
      if (rest.length < 1 || rest.length > 2) usage();
      return await core.attach(rest[0], rest[1]);
    case "down":
      if (rest.length !== 1) usage();
      {
        const d = await (await import("./daemon.ts")).daemonCall({ op: "down", project: rest[0] });
        if (d?.ev === "error") { console.error(`my-claude: ${d.error}`); return 1; }
        const done = d ? d.done : await core.down(rest[0]);
        console.log(done ? `${rest[0]} down (records and conversations kept)` : `${rest[0]} already down`);
      }
      return 0;
    case "ls": {
      const rows = await core.ls();
      if (rest[0] === "--json") console.log(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) console.log("no projects (my-claude new <name>)");
      else console.log(table([["PROJECT", "PEERS", "LEAD", "MODE", "STATE", "LAST_USED"], ...rows.map((r) => [r.name, String(r.peers), r.lead ?? "-", r.mode, r.state, ago(r.last_used)])]));
      return 0;
    }
    case "status": {
      if (rest.length < 1) usage();
      const s = await core.status(rest[0]);
      if (rest[1] === "--json") {
        console.log(JSON.stringify(s, null, 2));
        return 0;
      }
      console.log(`${s.name}: ${s.state}  mode=${s.mode} profile=${s.profile} lead=${s.lead ?? "-"}\ngoal: ${s.goal}`);
      console.log(table([["PEER", "PATH", "ROLE", "MODEL", "STATE", "PANE", "PID", "SESSION"],
        ...s.peers.map((p) => [p.repo, p.path, p.role, p.model ?? "default", p.state, p.pane ?? "-", p.pid ? String(p.pid) : "-", p.session.slice(0, 8)])]));
      if (s.strays.length) console.log(`stray panes (closed by up): ${s.strays.join(", ")}`);
      return 0;
    }
    case "lead":
      if (rest.length < 2) usage();
      return core.setLead(rest[0], rest[1], rest.length > 2 ? rest.slice(2).join(" ") : undefined)
        .then((notes) => { console.log(`${rest[1]} leads ${rest[0]}`); for (const n of notes) console.log("  " + n); return 0; });
    case "color":
      if (rest.length !== 2) usage();
      await core.setColor(rest[0], rest[1]);
      console.log(`${rest[0]} is ${rest[1]}`);
      return 0;
    case "brief":
      if (rest.length !== 1) usage();
      return core.brief(await core.status(rest[0])).then((notes) => { for (const n of notes) console.log(n); return 0; });
    case "set": {
      const { opts, pos } = parse(rest, ["--role", "--model", "--session"]);
      if (pos.length !== 2) usage();
      if (opts.role && opts.role !== "peer") usage();
      core.setPeer(pos[0], pos[1], { role: opts.role as Role | undefined, model: opts.model === undefined ? undefined : opts.model === "default" ? null : (opts.model as string), session: opts.session as string | undefined });
      console.log(`updated ${pos[1]}`);
      return 0;
    }
    case "restart":
      if (rest.length !== 2) usage();
      await core.restart(rest[0], rest[1]);
      console.log(`${rest[1]} relaunched`);
      return 0;
    case "takeover":
      if (rest.length !== 2) usage();
      await core.takeover(rest[0], rest[1]);
      console.log(`${rest[1]} taken over`);
      return 0;
    case "delete": {
      const { opts, pos } = parse(rest, [], ["--force"]);
      if (pos.length !== 1) usage();
      const { record, done } = await core.deleteProject(pos[0], !!opts.force);
      const left = await done;
      for (const l of left) console.error(l);
      console.log(`deleted ${pos[0]}; its record is in ${record} for undelete (conversations kept on disk)`);
      return left.length ? 1 : 0;
    }
    case "_click":
      await core.click(rest[0] ?? "", rest[1] ?? "");
      return 0;
    case "mcp":
      return import("./mcp.ts").then((m) => m.serve());
    case "build":
      console.log(await core.ensureBinary() ?? "dist/my-claude is current");
      return 0;
    case "readd": {
      if (rest.length < 1 || rest.length > 2) usage();
      if (rest.length === 1) {
        const r = load(rest[0]).removed ?? [];
        if (!r.length) { console.log("nothing removed"); return 0; }
        console.log(table([...r].reverse().map((x) => [x.repo, ago(Math.floor(x.when / 1000)), x.path])));
        return 0;
      }
      const peer = await core.readd(rest[0], rest[1], (m) => console.error(m));
      console.log(`${peer.repo} is back in ${rest[0]} at ${peer.path} (session ${peer.session.slice(0, 8)})`);
      return 0;
    }
    case "ticket": {
      if (rest.length < 1 || rest.length > 2) usage();
      if (rest.length === 1) { console.log(load(rest[0]).ticket ?? "-"); return 0; }
      const t = await core.setTicket(rest[0], rest[1]);
      console.log(t ? `${rest[0]} is for ${t}` : `${rest[0]}: ticket cleared`);
      return 0;
    }
    case "index": {
      if (rest.length < 1 || rest.length > 2) usage();
      const files = rest[1] ? [await core.index(rest[0], rest[1], true)].filter(Boolean) : await core.indexAll(rest[0], true);
      if (!files.length) { console.error("ctags not found; nothing indexed"); return 1; }
      for (const f of files) console.log(f);
      return 0;
    }
    case "undelete": {
      if (rest[0] === "--json") { console.log(JSON.stringify(core.trashed())); return 0; }
      if (rest.length > 1) usage();
      if (!rest.length) {
        const t = core.trashed();
        if (!t.length) { console.log("nothing in .trash"); return 0; }
        console.log(table(t.map((x) => [x.name, ago(Math.floor(x.when / 1000)), x.peers.join(" ") || "-", x.dir])));
        return 0;
      }
      const r = await core.undelete(rest[0], (m) => console.error(m));
      console.log(`restored ${r.name}${r.recloned.length ? ` (cloned again: ${r.recloned.join(", ")})` : ""}`);
      for (const m of r.missing) console.error(`missing: ${m}  (re-create it at that path, or add it again)`);
      for (const m of r.leftOut) console.error(`left out ${m}`);
      for (const m of r.notes) console.error(m);
      return r.missing.length ? 1 : 0;
    }
    case "next": case "prev": {
      if (await toHost({ op: "tab", cycle: cmd === "next" ? 1 : -1 })) return 0;
      const t = await core.cycle(cmd);
      if (!t) { console.error("no project sessions"); return 1; }
      if (!process.env.TMUX) console.log(`switched the attached client to ${t}`);
      return 0;
    }
    case "_menu": {
      const a = await core.contextMenu(rest[0] ?? "", rest[1] ?? "", rest.includes("--print"));
      if (rest.includes("--print")) console.log(a.map((x) => JSON.stringify(x)).join(" "));
      return 0;
    }
    case "_close-ask":
      await core.closeAsk(rest[0] ?? "", rest[1] ?? "");
      return 0;
    case "_close":
      console.log(await core.closePane(rest[0] ?? ""));
      return nudge();
    case "shell-min": {
      const v = await tmux.clientView();
      if (v?.sock) {
        const pane = rest[0] || (await tmux.activePeer())?.pane || "";
        const at = await core.paneFacts(pane);
        return hostSend({ op: "minimise", id: `${at.name}/${pane}` }, v.sock).then(() => 0);
      }
      await core.shellMinimise(rest[0] ?? "");
      return 0;
    }
    case "shell-here": {
      const at = await tmux.activePeer();
      return nudge(at?.name, await core.shellHere(rest[0] === "--host" ? "host" : "env"));
    }
    case "chat": {
      const at = await tmux.activePeer();
      return nudge(at?.name, await core.chat());
    }
    case "layout": {
      if (rest.length < 1 || rest.length > 2) usage();
      if (rest.length === 1) { console.log(load(rest[0]).layout ?? "grid"); return 0; }
      if (rest[1] !== "grid" && rest[1] !== "solo") usage();
      await core.setLayout(rest[0], rest[1]);
      console.log(`${rest[0]} is laid out ${rest[1]}`);
      return 0;
    }
    case "_view":
      if (rest.length !== 2) usage();
      return await tmux.view(rest[0], rest[1], process.env.MC_TERM_SOCKET ?? "");
    case "_host": {
      // _host <socket> <verb> [arg]: what a tmux menu item or key asks of the native app.
      const [sock, verb, arg] = rest;
      const event = (ev: object) => ({ op: "emit", event: ev });
      const msg = verb === "tab" ? (arg === "next" || arg === "prev" ? { op: "tab", cycle: arg === "next" ? 1 : -1 } : event({ ev: "action", action: "project.open", node: `p:${arg}` }))
        : verb === "sidebar" ? { op: "sidebar" }
        : verb === "minimise" ? { op: "minimise", id: arg }
        : verb === "zoom" ? { op: "zoom", id: arg }
        : verb === "focus" ? { op: "focus", id: arg }
        : verb === "nudge" ? event({ ev: "nudge" }) : null;
      if (!msg) usage();
      return hostSend(msg, sock || undefined).then((ok) => (ok ? 0 : 1));
    }
    case "deploy": return (await import("./deploy.ts")).deploy(rest);
    case "service": return (await import("./service.ts")).serviceCmd(rest);
    case "daemon": return (await import("./daemon.ts")).runDaemon();
    case "keepalive": return core.keepalive(rest.includes("--once"));
    case "remote": return (await import("./remote.ts")).remoteCmd(rest);
    case "_remote-gate": return (await import("./remote.ts")).remoteGate();
    case "gui":
      return import("./gui.ts").then((m) => m.launch(rest));
    case "_gui":
      return import("./gui.ts").then((m) => m.drive());
    case "_chat":
      if (rest.length !== 1) usage();
      return await core.chatPane(rest[0]);
    case "_sync-group":
      if (rest.length !== 1) usage();
      return core.syncGroupNow(rest[0]).then(() => 0);
    case "panel": {
      if (await toHost({ op: "sidebar" })) return 0;
      if (!process.env.TMUX) usage();
      await core.panel();
      return 0;
    }
    case "_panel":
      return spawnSync(process.execPath, ["run", `${ROOT}/src/menu/panel.tsx`], { stdio: "inherit" }).status ?? 1;
    case "_tile":
      if (rest.length !== 1) usage();
      await tmux.tile(rest[0]);
      return 0;
    case "_shell":
      if (rest.length < 2 || rest.length > 3) usage();
      return core.shellPane(rest[0], rest[1], rest[2] === "--host");
    case "_launch":
      if (rest.length !== 2) usage();
      return core.launch(rest[0], rest[1]);
    case "-h": case "--help": case "help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`my-claude: unknown command '${cmd}'`);
      usage();
  }
}

// The menu runs as a child that exits with a request ("attach <project> <repo>"), so tmux can
// own the terminal; it reopens on that project after the detach.
async function menuLoop(): Promise<number> {
  if (!process.stdin.isTTY) usage();
  // Ctrl-C belongs to whichever child owns the terminal (menu or tmux), never to this loop.
  process.on("SIGINT", () => {});
  const reset = () => {
    spawnSync("stty", ["sane"], { stdio: "inherit" });
    process.stdout.write("\x1b[2J\x1b[H");
  };
  const req = `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/my-claude-menu.req`;
  let open = "", select = "";
  for (;;) {
    try { unlinkSync(req); } catch { /* none */ }
    writeFileSync(req, "");
    reset();
    spawnSync(process.execPath, ["run", `${ROOT}/src/menu/index.tsx`], {
      stdio: "inherit",
      env: { ...process.env, MY_CLAUDE_REQUEST: req, MY_CLAUDE_OPEN: open, MY_CLAUDE_SELECT: select },
    });
    let line = "";
    try { line = readFileSync(req, "utf8").trim(); } catch { /* none */ }
    if (!line) return 0;
    const [action, name, repo] = line.split(" ");
    if (action === "attach") {
      open = ""; select = name;
      try {
        for (const r of await core.up(name)) console.log(`${r.repo}: ${r.action}${r.detail ? " " + r.detail : ""}`);
      } catch (e) { console.error(String(e instanceof Error ? e.message : e)); }
      console.log(`attaching to ${name}...`);
      try { unlinkSync(tmux.LAST_SESSION_FILE); } catch { /* none */ }
      try { await core.attach(name, repo || undefined); } catch (e) { console.error(String(e instanceof Error ? e.message : e)); }
      // Back on the project list with the cursor on the project the user detached from
      // (not necessarily the one they joined), one Enter from re-entering it.
      const last = tmux.lastDetachedProject();
      if (last && (await core.ls()).some((p) => p.name === last)) select = last;
    }
  }
}

const fail = (e: unknown) => {
  if (e instanceof UsageError) {
    console.error(`my-claude: ${e.message}`);
    process.exit(2);
  }
  throw e;
};
try {
  Promise.resolve(main(process.argv.slice(2))).then((rc) => process.exit(rc), fail);
} catch (e) {
  fail(e);
}
