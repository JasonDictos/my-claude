#!/usr/bin/env bun
// my-claude: a project is one long-lived Claude session per repo, provisioned
// as one tmux session (one tiled pane per peer) and resumable by conversation
// id. No arguments opens the menu. See docs/superpowers/specs/.
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as core from "./core.ts";
import * as tmux from "./tmux.ts";
import { ROOT, UsageError, type Role } from "./store.ts";

const USAGE = `usage: my-claude <command> [args]      (no command: interactive menu)
  new    <project> [--shared] [--profile P] [--color blue|orange|green|purple|red|yellow|teal|pink]
  color  <project> <color>
  add    <project> <spec> [<spec>...] [--model M]
         spec: <path> | <repo> | <org>/<repo> | <git url> | <PR url>, each with optional --branch B --name N
         a path is symlinked into projects/<project>/; anything else is cloned there fresh
  rm     <project> <repo>
  up     <project> [--no-attach]
  attach <project> [<repo>]
  down   <project>
  ls     [--json]
  status <project> [--json]
  lead   <project> <repo> [GOAL TEXT]    set the lead (and the goal), brief everyone via claude-peers
  brief  <project>                       resend the briefs
  set    <project> <repo> [--role peer] [--model M|default] [--session <id or prefix>]
  restart  <project> <repo>      stop the peer's claude and start it again in the same pane, same conversation
  takeover <project> <repo>      kill the stranger occupying the repo, launch the peer
  delete <project> [--force]     down + move the project dir to .trash/ (conversations kept)
  undelete [<project>]           bring a deleted project back (same paths, same conversations); no arg lists .trash/
  next | prev                    inside tmux: switch to the next/previous project session (also prefix+Tab / prefix+Shift+Tab)
  shell-here                     inside a project pane: a shell in that peer's container, in a pane below (also prefix+h)`;

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

function main(argv: string[]): number | Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd) return menuLoop();
  switch (cmd) {
    case "new": {
      const { opts, pos } = parse(rest, ["--goal", "--profile", "--color"], ["--shared"]);
      if (pos.length !== 1) usage();
      const p = core.newProject(pos[0], { goal: opts.goal as string, shared: !!opts.shared, profile: opts.profile as string, color: opts.color as string });
      console.log(`created ${p.name} (${p.mode}, profile ${p.profile})`);
      return 0;
    }
    case "add": {
      // --role/--model apply to the first repo; --branch/--name travel with the spec they follow.
      const [project, ...specWords] = rest;
      if (!project) usage();
      const words: string[] = [];
      const o: { model?: string | null } = {};
      for (let i = 0; i < specWords.length; i++) {
        if (specWords[i] === "--model") o.model = specWords[++i] ?? usage();
        else words.push(specWords[i]);
      }
      if (!words.length) usage();
      return core.addRepos(project, words.join(" "), { ...o, log: console.log })
        .then(async (peers) => { for (const peer of peers) console.log(`added ${peer.repo} (${peer.role}) to ${project} at ${peer.path}`); await core.syncGroupNow(project); return 0; });
    }
    case "rm": {
      if (rest.length !== 2) usage();
      const note = core.rmPeer(rest[0], rest[1]);
      console.log(`removed ${rest[1]} from ${rest[0]} (conversation kept on disk${note ? "; " + note : ""})`);
      return core.syncGroupNow(rest[0]).then(() => 0);
    }
    case "up": {
      const { opts, pos } = parse(rest, [], ["--no-attach"]);
      if (pos.length !== 1) usage();
      for (const r of core.up(pos[0])) {
        console.log(r.action === "skipped" ? `${r.repo}: SKIP, occupied by a session my-claude did not start:\n   ${r.detail}` : `${r.repo}: ${r.action}`);
      }
      return core.syncGroupNow(pos[0]).then(() => (opts["no-attach"] ? 0 : core.attach(pos[0])));
    }
    case "attach":
      if (rest.length < 1 || rest.length > 2) usage();
      return core.attach(rest[0], rest[1]);
    case "down":
      if (rest.length !== 1) usage();
      console.log(core.down(rest[0]) ? `${rest[0]} down (records and conversations kept)` : `${rest[0]} already down`);
      return 0;
    case "ls": {
      const rows = core.ls();
      if (rest[0] === "--json") console.log(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) console.log("no projects (my-claude new <name>)");
      else console.log(table([["PROJECT", "PEERS", "LEAD", "MODE", "STATE", "LAST_USED"], ...rows.map((r) => [r.name, String(r.peers), r.lead ?? "-", r.mode, r.state, ago(r.last_used)])]));
      return 0;
    }
    case "status": {
      if (rest.length < 1) usage();
      const s = core.status(rest[0]);
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
      core.setColor(rest[0], rest[1]);
      console.log(`${rest[0]} is ${rest[1]}`);
      return 0;
    case "brief":
      if (rest.length !== 1) usage();
      return core.brief(core.status(rest[0])).then((notes) => { for (const n of notes) console.log(n); return 0; });
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
      core.restart(rest[0], rest[1]);
      console.log(`${rest[1]} relaunched`);
      return 0;
    case "takeover":
      if (rest.length !== 2) usage();
      core.takeover(rest[0], rest[1]);
      console.log(`${rest[1]} taken over`);
      return 0;
    case "delete":
      if (rest.length < 1 || rest.length > 2) usage();
      console.log(`deleted ${rest[0]} -> ${core.deleteProject(rest[0], rest[1] === "--force")} (conversations kept on disk)`);
      return 0;
    case "undelete": {
      if (rest.length > 1) usage();
      if (!rest.length) {
        const t = core.trashed();
        if (!t.length) { console.log("nothing in .trash"); return 0; }
        console.log(table(t.map((x) => [x.name, ago(Math.floor(x.when / 1000)), x.peers.join(" ") || "-", x.dir])));
        return 0;
      }
      const r = core.undelete(rest[0], (m) => console.error(m));
      console.log(`restored ${r.name}${r.recloned.length ? ` (cloned again: ${r.recloned.join(", ")})` : ""}`);
      for (const m of r.missing) console.error(`missing: ${m}  (re-create it at that path, or add it again)`);
      return r.missing.length ? 1 : 0;
    }
    case "next": case "prev": {
      const t = core.cycle(cmd);
      if (!t) { console.error("no project sessions"); return 1; }
      if (!process.env.TMUX) console.log(`switched the attached client to ${t}`);
      return 0;
    }
    case "shell-here":
      core.shellHere();
      return 0;
    case "panel":
      if (!process.env.TMUX) usage();
      core.panel();
      return 0;
    case "_panel":
      return spawnSync(process.execPath, ["run", `${ROOT}/src/menu/panel.tsx`], { stdio: "inherit" }).status ?? 1;
    case "_tile":
      if (rest.length !== 1) usage();
      tmux.tile(rest[0]);
      return 0;
    case "_shell":
      if (rest.length !== 2) usage();
      return core.shellPane(rest[0], rest[1]);
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

// The menu runs as a child so tmux attach can own the terminal between runs:
// it exits writing a request file ("attach <project> <repo>"), we attach, and
// reopen the menu on the project when the user detaches.
function menuLoop(): number {
  if (!process.stdin.isTTY) usage();
  // Ctrl-C belongs to whichever child owns the terminal (menu or tmux), never to this loop.
  process.on("SIGINT", () => {});
  const reset = () => {
    spawnSync("stty", ["sane"], { stdio: "inherit" });
    process.stdout.write("\x1b[2J\x1b[H");
  };
  const req = `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/my-claude-menu.req`;
  let open = "";
  for (;;) {
    try { unlinkSync(req); } catch { /* none */ }
    writeFileSync(req, "");
    reset();
    spawnSync(process.execPath, ["run", `${ROOT}/src/menu/index.tsx`], {
      stdio: "inherit",
      env: { ...process.env, MY_CLAUDE_REQUEST: req, MY_CLAUDE_OPEN: open },
    });
    let line = "";
    try { line = readFileSync(req, "utf8").trim(); } catch { /* none */ }
    if (!line) return 0;
    const [action, name, repo] = line.split(" ");
    if (action === "attach") {
      open = name;
      try {
        for (const r of core.up(name)) console.log(`${r.repo}: ${r.action}${r.detail ? " " + r.detail : ""}`);
      } catch (e) { console.error(String(e instanceof Error ? e.message : e)); }
      console.log(`attaching to ${name}...`);
      try { core.attach(name, repo || undefined); } catch (e) { console.error(String(e instanceof Error ? e.message : e)); }
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
