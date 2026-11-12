// The menu: DOS-style, keyboard only, two screens. Rendered with Ink (the same
// React-for-terminals Claude Code uses). Started by `my-claude` with no args;
// "Join" exits with a request so the parent can hand the terminal to tmux.
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import React, { useEffect, useState } from "react";
import * as core from "../core.ts";
import type { PeerStatus, ProjectRow, ProjectStatus } from "../core.ts";
import { attentionColor } from "../attention.ts";
import { profile } from "../profiles/index.ts";
import type { ProfileAction } from "../profiles/types.ts";
import { PROJECTS, defaultProfile, slug } from "../store.ts";
import { COLOR_CHOICES, PALETTE, projectColor } from "../colors.ts";
import { candidates, history, predict, remember } from "./history.ts";
import { sizeMark, useTermSize } from "./size.ts";

// Actions the default profile adds to the projects screen (e.g. a "New ticket" that files an issue and opens a project).
const ACTIONS: ProfileAction[] = (() => {
  try {
    return profile(defaultProfile()).actions ?? [];
  } catch {
    return [];
  }
})();

const MODELS = ["default", "fable-5.1", "opus-5.5", "sonnet-5.5"];
const REQUEST = process.env.MY_CLAUDE_REQUEST ?? "";

type Prompt =
  | { kind: "text" | "path"; label: string; value: string; onSubmit: (v: string) => void; key?: string; hist?: number; cursor?: number }
  | { kind: "confirm"; label: string; onYes: () => void }
  | { kind: "choice"; label: string; choices: string[]; index: number; onPick: (v: string) => void };

const ago = (epoch: number) => {
  if (!epoch) return "never";
  const s = Math.floor(Date.now() / 1000 - epoch);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
const expand = (p: string) => (p.startsWith("~") ? homedir() + p.slice(1) : p);

// Tab completion for paths: longest common prefix of matching directory entries.
function completePath(v: string): string {
  const full = expand(v);
  const dir = full.endsWith("/") ? full : dirname(full);
  const base = full.endsWith("/") ? "" : full.slice(dir.length + (dir === "/" ? 0 : 1));
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(base) && (base.startsWith(".") || !n.startsWith(".")));
  } catch {
    return v;
  }
  if (names.length === 0) return v;
  let common = names[0];
  for (const n of names) while (!n.startsWith(common)) common = common.slice(0, -1);
  let out = join(dir, common);
  if (names.length === 1) {
    try { if (statSync(out).isDirectory()) out += "/"; } catch { /* keep */ }
  }
  return v.startsWith("~") ? "~" + out.slice(homedir().length) : out;
}

// Columns size to their content; the one marked flex takes whatever width is left.
interface Col<T> {
  h: string;
  v: (row: T) => string;
  flex?: boolean;
  color?: (row: T) => string | undefined;
}

function Table<T>({ cols, rows, sel, width }: { cols: Col<T>[]; rows: T[]; sel: number; width: number }) {
  const gap = 2;
  const widths = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => c.v(r).length)));
  const flex = cols.findIndex((c) => c.flex);
  const fixed = widths.reduce((a, w, i) => (i === flex ? a : a + w), 0) + gap * (cols.length - 1) + 2;
  if (flex >= 0) widths[flex] = Math.max(cols[flex].h.length, Math.min(widths[flex], width - fixed));
  const cell = (s: string, i: number) => pad(s, widths[i]) + (i < cols.length - 1 ? " ".repeat(gap) : "");
  return (
    <Box flexDirection="column">
      <Text dimColor>{"  " + cols.map((c, i) => cell(c.h, i)).join("")}</Text>
      {rows.map((r, ri) => (
        <Text key={ri} inverse={ri === sel}>
          {ri === sel ? "▶ " : "  "}
          {cols.map((c, i) => {
            const color = c.color?.(r);
            return color && ri !== sel ? <Text key={i} color={color}>{cell(c.v(r), i)}</Text> : <Text key={i}>{cell(c.v(r), i)}</Text>;
          })}
        </Text>
      ))}
    </Box>
  );
}

function Bar({ title, right, color = "cyan" }: { title: string; right?: string; color?: string }) {
  const { stdout } = useStdout();
  const w = stdout.columns ?? 80;
  const body = ` ${title} `;
  const room = Math.max(0, w - body.length - 2);
  const r = right ? ` ${right.length > room ? right.slice(0, Math.max(0, room - 1)) + "…" : right} ` : "";
  return (
    <Text backgroundColor={color} color="black">
      {body}{"─".repeat(Math.max(0, w - body.length - r.length))}{r}
    </Text>
  );
}

function Keys({ keys }: { keys: [string, string][] }) {
  return (
    <Box>
      {keys.map(([k, label]) => (
        <Text key={k}>
          <Text backgroundColor="cyan" color="black" bold> {k} </Text>
          <Text> {label}  </Text>
        </Text>
      ))}
    </Box>
  );
}

function PromptLine({ prompt }: { prompt: Prompt }) {
  if (prompt.kind === "confirm") return <Text color="yellow">{prompt.label} [y/N] </Text>;
  if (prompt.kind === "choice")
    return (
      <Box>
        <Text color="yellow">{prompt.label}: </Text>
        {prompt.choices.map((c, i) => (
          PALETTE[c]
            ? <Text key={c} backgroundColor={i === prompt.index ? PALETTE[c].ink : undefined} color={i === prompt.index ? "black" : PALETTE[c].ink}> ■ {c} </Text>
            : <Text key={c} inverse={i === prompt.index}> {c} </Text>
        ))}
      </Box>
    );
  // Our own line editor: the prompt owns value AND cursor, so ghost accept, history
  // recall and tab completion all leave the cursor where the text ends.
  const v = prompt.value;
  const c = Math.min(prompt.cursor ?? v.length, v.length);
  const ghost = c === v.length && prompt.key ? predict(v, candidates(prompt.key), prompt.key !== "add") : "";
  return (
    <Box>
      <Text color="yellow">{prompt.label}: </Text>
      <Text>{v.slice(0, c)}</Text>
      <Text inverse>{c < v.length ? v[c] : " "}</Text>
      <Text>{v.slice(c + 1)}</Text>
      {ghost && <Text dimColor>{ghost}</Text>}
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const { columns, rows: lines, seq } = useTermSize();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState<string | null>(process.env.MY_CLAUDE_OPEN || null);
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [psel, setPsel] = useState(0);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);

  const refresh = () => setTick((t) => t + 1);
  useEffect(() => {
    try {
      setRows(core.ls());
      if (open) setStatus(core.status(open));
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
      if (open) setOpen(null);
    }
  }, [tick, open]);
  useEffect(() => {
    // Poll for liveness (tmux/process state) and watch the records so a change made
    // from another shell's menu or the CLI shows up here at once.
    const t = setInterval(refresh, 2000);
    // Only the records matter, so only projects/ and each projects/<name>/ are watched,
    // flat. A recursive watch would cover every clone and build tree: thousands of
    // inotify watches, a redraw storm during a clone, and a crash the moment a build
    // run as root creates a directory this user may not watch.
    const watchers = new Map<string, ReturnType<typeof watch>>();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const changed = () => { if (!pending) pending = setTimeout(() => { pending = null; refresh(); rearm(); }, 150); };
    const arm = (dir: string) => {
      if (watchers.has(dir)) return;
      try {
        const w = watch(dir, changed);
        w.on("error", () => { w.close(); watchers.delete(dir); }); // gone or unreadable: polling covers it
        watchers.set(dir, w);
      } catch { /* not there yet; polling covers it */ }
    };
    const rearm = () => {
      arm(PROJECTS);
      let names: string[] = [];
      try { names = readdirSync(PROJECTS); } catch { /* no projects dir yet */ }
      const want = new Set([PROJECTS, ...names.map((n) => join(PROJECTS, n))]);
      for (const [dir, w] of watchers) if (!want.has(dir)) { w.close(); watchers.delete(dir); }
      for (const dir of want) arm(dir);
    };
    rearm();
    return () => { clearInterval(t); for (const w of watchers.values()) w.close(); if (pending) clearTimeout(pending); };
  }, []);

  const act = (f: () => void, done?: string) => {
    try {
      f();
      setMsg(done ?? "");
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    }
    refresh();
  };
  const request = (line: string) => {
    if (REQUEST) writeFileSync(REQUEST, line + "\n");
    exit();
  };

  // Walk an action's prompts one at a time, then run it (async: it may call out to a tracker).
  const runAction = (a: ProfileAction, answers: string[] = []) => {
    const i = answers.length;
    if (i < a.prompts.length) {
      const q = a.prompts[i];
      if (q.kind === "choice")
        setPrompt({ kind: "choice", label: q.label, choices: q.choices ?? [], index: 0, onPick: (v) => runAction(a, [...answers, v]) });
      else
        setPrompt({ kind: "text", key: `${a.label}:${q.label}`, label: q.label, value: q.default ?? "", onSubmit: (v) => { setPrompt(null); runAction(a, [...answers, v]); } });
      return;
    }
    setPrompt(null);
    setMsg(`${a.label}: working...`);
    a.run(answers).then((r) => {
      if (r.createProject) {
        act(() => core.newProject(r.createProject!.name, { goal: r.createProject!.goal, shared: r.createProject!.shared }), r.message);
        setOpen(r.createProject.name); setPsel(0);
      } else { setMsg(r.message); refresh(); }
    }).catch((e) => setMsg(`${a.label} failed: ${e instanceof Error ? e.message : e}`));
  };

  const cur = rows[Math.min(sel, Math.max(0, rows.length - 1))];
  const peer: PeerStatus | undefined = status?.peers[Math.min(psel, Math.max(0, (status?.peers.length ?? 1) - 1))];

  useInput((input, key) => {
    const esc = key.escape || (key.ctrl && input === "c");
    if (prompt) {
      if (esc) return setPrompt(null);
      if (prompt.kind === "confirm") {
        if (input === "y" || input === "Y") { setPrompt(null); prompt.onYes(); } else if (input) setPrompt(null);
        return;
      }
      if (prompt.kind === "choice") {
        if (key.leftArrow || key.upArrow) setPrompt({ ...prompt, index: (prompt.index + prompt.choices.length - 1) % prompt.choices.length });
        else if (key.rightArrow || key.downArrow || key.tab) setPrompt({ ...prompt, index: (prompt.index + 1) % prompt.choices.length });
        else if (key.return) { setPrompt(null); prompt.onPick(prompt.choices[prompt.index]); }
        return;
      }
      const v = prompt.value;
      const c = Math.min(prompt.cursor ?? v.length, v.length);
      const set = (value: string, cursor = value.length) => setPrompt({ ...prompt, value, cursor, hist: -1 });
      if (key.return) {
        setPrompt(null);
        if (prompt.key) remember(prompt.key, v);
        return prompt.onSubmit(v);
      }
      const ghost = c === v.length && prompt.key ? predict(v, candidates(prompt.key), prompt.key !== "add") : "";
      if ((key.tab || key.rightArrow) && ghost) return set(v + ghost);
      if (prompt.kind === "path" && key.tab) return set(completePath(v));
      if ((key.upArrow || key.downArrow) && prompt.key) {
        const h = history(prompt.key);
        if (!h.length) return;
        const cur = prompt.hist ?? -1;
        const next = key.upArrow ? Math.min(cur + 1, h.length - 1) : Math.max(cur - 1, -1);
        const value = next < 0 ? "" : h[next];
        return setPrompt({ ...prompt, value, cursor: value.length, hist: next });
      }
      if (key.leftArrow) return set(v, Math.max(0, c - 1));
      if (key.rightArrow) return set(v, Math.min(v.length, c + 1));
      if (key.ctrl && input === "a") return set(v, 0);
      if (key.ctrl && input === "e") return set(v, v.length);
      if (key.ctrl && input === "u") return set(v.slice(c), 0);
      if (key.ctrl && input === "k") return set(v.slice(0, c));
      if (key.ctrl && input === "w") {
        const head = v.slice(0, c).replace(/\S+\s*$/, "");
        return set(head + v.slice(c), head.length);
      }
      // Ink reports Backspace (DEL) as key.delete; both erase before the cursor.
      if (key.backspace || key.delete) return c > 0 ? set(v.slice(0, c - 1) + v.slice(c), c - 1) : undefined;
      if (input && !key.ctrl && !key.meta) return set(v.slice(0, c) + input + v.slice(c), c + input.length);
      return;
    }
    if (esc || input === "q") {
      if (open) { setOpen(null); setStatus(null); setMsg(""); } else exit();
      return;
    }
    if (!open) {
      if (key.upArrow) setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setSel((s) => Math.min(rows.length - 1, s + 1));
      else if (key.return && cur) { setOpen(cur.name); setPsel(0); setMsg(""); }
      else if (input === "n") setPrompt({ kind: "text", key: "name", label: "New project name", value: "", onSubmit: (typed) => {
        setPrompt(null);
        const name = slug(typed);
        if (!name) return;
        setPrompt({ kind: "choice", label: "Containers", choices: ["one per repo", "one shared"], index: 0, onPick: (m) => {
          setPrompt({ kind: "choice", label: "Color", choices: COLOR_CHOICES, index: 0, onPick: (color) => {
            act(() => core.newProject(name, { shared: m === "one shared", color }), `created ${name}; add repos with a`);
            setOpen(name); setPsel(0);
          } });
        } });
      } });
      else if (input === "u" && cur) act(() => { core.up(cur.name); }, `${cur.name} up`);
      else if (input === "d" && cur) act(() => { core.down(cur.name); }, `${cur.name} down`);
      else if (input === "U") {
        const t = core.trashed();
        if (!t.length) setMsg("nothing in .trash");
        else setPrompt({ kind: "choice", label: "Undelete", choices: t.map((x) => x.dir), index: 0, onPick: (dir) => act(() => {
          const r = core.undelete(dir, (m) => setMsg(m));
          setMsg(`restored ${r.name}${r.recloned.length ? `; cloned again: ${r.recloned.join(", ")}` : ""}${r.missing.length ? `; missing: ${r.missing.join(", ")}` : ""}`);
        }) });
      }
      else if (input === "x" && cur) {
        const clones = core.clonesOf(cur.name);
        setPrompt({ kind: "confirm", label: clones.length ? `Delete ${cur.name} and move its clones (${clones.join(", ")}) to .trash?` : `Delete project ${cur.name} (conversations stay on disk)?`, onYes: () => act(() => { const d = core.deleteProject(cur.name, true); setMsg(`moved to ${tilde(d)}`); }) });
      }
      else {
        const a = ACTIONS.find((x) => x.key === input);
        if (a) runAction(a);
      }
      return;
    }
    // project screen
    const name = open;
    if (key.upArrow) setPsel((s) => Math.max(0, s - 1));
    else if (key.downArrow) setPsel((s) => Math.min((status?.peers.length ?? 1) - 1, s + 1));
    else if (key.return) {
      if (peer?.state === "occupied") setPrompt({ kind: "choice", label: `${peer.repo} is held by a session my-claude did not start`, choices: ["take over", "leave it", "skip"], index: 0, onPick: (c) => {
        if (c === "take over") act(() => core.takeover(name, peer.repo), `${peer.repo} taken over`);
      } });
      else request(`attach ${name} ${peer?.repo ?? ""}`);
    }
    else if (input === "a") setPrompt({ kind: "path", key: "add", label: "Add repos", value: "", onSubmit: (line) => {
      setPrompt(null);
      if (!line.trim()) return;
      core.addRepos(name, line, { log: (s) => { setMsg(s); refresh(); } })
        .then((peers) => { setMsg(`added ${peers.map((p) => p.repo).join(", ")}`); refresh(); })
        .catch((e) => { setMsg(String(e instanceof Error ? e.message : e)); refresh(); });
    } });
    else if (input === "l" && peer) setPrompt({ kind: "text", key: "goal", label: `Goal for ${peer.repo} as lead`, value: status?.goal ?? "", onSubmit: (goal) => {
      setPrompt(null);
      setMsg("briefing...");
      core.setLead(name, peer.repo, goal).then((notes) => { setMsg(`${peer.repo} leads; ${notes.join("; ")}`); refresh(); })
        .catch((e) => { setMsg(String(e instanceof Error ? e.message : e)); refresh(); });
    } });
    else if (input === "b" && status?.lead) { setMsg("briefing..."); core.brief(status).then((n) => { setMsg(n.join("; ")); }).catch((e) => setMsg(String(e))); }
    else if (input === "m" && peer) setPrompt({ kind: "choice", label: `Model for ${peer.repo}`, choices: MODELS, index: Math.max(0, MODELS.indexOf(peer.model ?? "default")), onPick: (m) => act(() => core.setPeer(name, peer.repo, { model: m === "default" ? null : m }), "model set; takes effect on restart (R)") });
    else if (input === "R" && peer) setPrompt({ kind: "confirm", label: `Relaunch ${peer.repo}'s claude on the same conversation?`, onYes: () => act(() => core.restart(name, peer.repo), `${peer.repo} relaunched`) });
    else if (input === "c") setPrompt({ kind: "choice", label: "Color", choices: Object.keys(PALETTE), index: Math.max(0, Object.keys(PALETTE).indexOf(status?.color ?? "")), onPick: (color) => act(() => core.setColor(name, color), `${name} is ${color}`) });
    else if (input === "u") act(() => { core.up(name); }, "up");
    else if (input === "d") act(() => { core.down(name); }, "down");
    else if (input === "x" && peer) setPrompt({ kind: "confirm", label: `Remove ${peer.repo} from ${name}?`, onYes: () => act(() => { const note = core.rmPeer(name, peer.repo); setMsg(`removed ${peer.repo}${note ? "; " + note : ""}`); }) });
  });

  const liveMark = (s: string) => (s === "live" ? "●" : s === "occupied" ? "!" : s === "starting" ? "◐" : s === "idle" ? "◌ shell" : "○");
  const liveColor = (s: string) => (s === "live" ? "green" : s === "occupied" ? "red" : s === "starting" || s === "idle" ? "yellow" : undefined);

  if (open && status) {
    const peerCols: Col<PeerStatus>[] = [
      { h: "Peer", v: (p) => p.repo },
      { h: "Repo", v: (p) => tilde(p.path), flex: true },
      { h: "Role", v: (p) => (p.role === "lead" ? "LEAD" : "-") },
      { h: "Model", v: (p) => p.model ?? "default" },
      { h: "Live", v: (p) => liveMark(p.state), color: (p) => liveColor(p.state) },
      { h: "Needs", v: (p) => (p.attn === "ask" ? "! answer" : p.attn === "wait" ? "✉ prompt" : "-"), color: (p) => attentionColor(p.attn) },
      { h: "Session", v: (p) => p.session.slice(0, 8) },
    ];
    return (
      <Box flexDirection="column" height={lines}>
        <Bar title={status.name} color={projectColor(status.name, status.color).ink} right={`peers group "${core.GROUP(status.name)}" · ${status.mode === "shared" ? "shared container" : "container per repo"} · ${status.state}${sizeMark(seq)}`} />
        <Table cols={peerCols} rows={status.peers} sel={psel} width={columns} />
        {status.peers.length === 0 && <Text dimColor>  no peers yet; press a to add a repo</Text>}
        {status.strays.length > 0 && <Text color="yellow">  stray panes (closed on u): {status.strays.join(", ")}</Text>}
        <Box marginTop={1}><Text> Goal: {status.goal || <Text dimColor>(set with the lead: l)</Text>}</Text></Box>
        <Box flexGrow={1} />
        <Box>{prompt ? <PromptLine prompt={prompt} /> : <Text color={msg.includes("fail") || msg.includes("not") || msg.includes("no ") ? "red" : "green"}> {msg}</Text>}</Box>
        <Keys keys={[["Enter", "Join"], ["a", "Add repos"], ["l", "Lead+goal"], ["b", "Brief"], ["m", "Model"], ["c", "Color"], ["R", "Relaunch"], ["u", "Up"], ["d", "Down"], ["x", "Remove"], ["Esc", "Back"]]} />
      </Box>
    );
  }

  const projCols: Col<ProjectRow>[] = [
    { h: "Project", v: (r) => r.name, flex: true, color: (r) => projectColor(r.name, r.color).ink },
    { h: "Peers", v: (r) => String(r.peers) },
    { h: "Lead", v: (r) => r.lead ?? "-" },
    { h: "Mode", v: (r) => (r.mode === "shared" ? "shared" : "per-repo") },
    { h: "State", v: (r) => r.state, color: (r) => (r.state === "UP" ? "green" : r.state === "PARTIAL" ? "yellow" : undefined) },
    { h: "Needs", v: (r) => (r.attn === "ask" ? "! answer" : r.attn === "wait" ? "✉ prompt" : "-"), color: (r) => attentionColor(r.attn) },
    { h: "Last used", v: (r) => ago(r.last_used) },
  ];
  return (
    <Box flexDirection="column" height={lines}>
      <Bar title="my-claude" right={hostname() + sizeMark(seq)} />
      <Table cols={projCols} rows={rows} sel={sel} width={columns} />
      {rows.length === 0 && <Text dimColor>  no projects yet; press n</Text>}
      <Box marginTop={1}><Text> Goal: {cur?.goal || <Text dimColor>(none)</Text>}</Text></Box>
      <Box flexGrow={1} />
      <Box>{prompt ? <PromptLine prompt={prompt} /> : <Text color="green"> {msg}</Text>}</Box>
      <Keys keys={[["Enter", "Open"], ["n", "New"], ...ACTIONS.map((a): [string, string] => [a.key === a.key.toUpperCase() && a.key !== a.key.toLowerCase() ? `⇧${a.key.toLowerCase()}` : a.key, a.label]), ["u", "Up"], ["d", "Down"], ["x", "Delete"], ["⇧u", "Undelete"], ["Esc", "Quit"]]} />
    </Box>
  );
}

// Alternate screen: the menu owns the whole terminal and leaves no scrollback behind.
// Never outlive the terminal: a pane killed or replaced (respawn-pane) sends HUP and
// closes the pty; without this the process spins on a dead stdin/stdout.
const bail = () => { try { process.stdout.write("\x1b[?1049l"); } catch { /* gone */ } process.exit(0); };
for (const sig of ["SIGHUP", "SIGTERM"] as const) process.on(sig, bail);
process.stdin.on("end", bail); process.stdin.on("error", bail); process.stdout.on("error", bail);
process.stdout.write("\x1b[?1049h\x1b[H");
const app = render(<App />, { exitOnCtrlC: false });
app.waitUntilExit().finally(() => process.stdout.write("\x1b[?1049l"));
