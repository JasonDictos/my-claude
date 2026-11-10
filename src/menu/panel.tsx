// The side panel: a pane docked left in every project session listing the projects.
// Enter switches the client there, Esc hands focus back to the pane you came from,
// q closes the panel.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import * as core from "../core.ts";
import * as tmux from "../tmux.ts";
import { projectColor } from "../colors.ts";
import { candidates, predict, remember } from "./history.ts";
import { sizeMark, useTermSize } from "./size.ts";

type Row = { name: string; state: string; color: string | null; peers: number };

const rows = (): Row[] => core.ls().map((p) => ({ name: p.name, state: p.state, color: p.color, peers: p.peers }));
const stateMark = (s: string) => (s === "UP" ? "●" : s === "PARTIAL" ? "◐" : "○");
const stateColor = (s: string) => (s === "UP" ? "green" : s === "PARTIAL" ? "yellow" : "gray");

function Panel({ session }: { session: string }) {
  const { exit } = useApp();
  const { columns: width, rows: height, seq } = useTermSize();

  const [list, setList] = useState<Row[]>(() => rows());
  const listRef = useRef(list); listRef.current = list;
  const [sel, setSel] = useState(() => Math.max(0, rows().findIndex((r) => r.name === session)));
  const [msg, setMsg] = useState("");
  // `a`: add repos to the highlighted project, typed right here (same specs as the menu).
  const [add, setAdd] = useState<{ name: string; value: string; cursor: number } | null>(null);
  useEffect(() => {
    const t = setInterval(() => setList(rows()), 2000);
    // Another panel may have switched the client here with its arrows: show this project highlighted.
    const snap = setInterval(() => { if (tmux.currentSession() === `mc-${session}`) setSel((s) => { const i = listRef.current.findIndex((r) => r.name === session); return i < 0 ? s : i; }); }, 500);
    return () => { clearInterval(t); clearInterval(snap); };
  }, []);

  useInput((input, key) => {
    if (add) {
      const v = add.value;
      const c = Math.min(add.cursor, v.length);
      const set = (value: string, cursor = value.length) => setAdd({ ...add, value, cursor });
      if (key.escape || (key.ctrl && input === "c")) return setAdd(null);
      if (key.return) {
        setAdd(null);
        if (!v.trim()) return;
        remember("add", v);
        setMsg(`adding to ${add.name}...`);
        core.addRepos(add.name, v, { log: (m) => setMsg(m) })
          .then((peers) => { setMsg(`added ${peers.map((p) => p.repo).join(", ")}`); setList(rows()); })
          .catch((e) => setMsg(String(e instanceof Error ? e.message : e)));
        return;
      }
      const ghost = c === v.length ? predict(v, candidates("add"), false) : "";
      if ((key.tab || key.rightArrow) && ghost) return set(v + ghost);
      if (key.leftArrow) return set(v, Math.max(0, c - 1));
      if (key.rightArrow) return set(v, Math.min(v.length, c + 1));
      if (key.ctrl && input === "u") return set(v.slice(c), 0);
      if (key.ctrl && input === "w") { const head = v.slice(0, c).replace(/\S+\s*$/, ""); return set(head + v.slice(c), head.length); }
      if (key.backspace || key.delete) return c > 0 ? set(v.slice(0, c - 1) + v.slice(c), c - 1) : undefined;
      if (input && !key.ctrl && !key.meta) return set(v.slice(0, c) + input + v.slice(c), c + input.length);
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (input === "a" && list[sel]) return setAdd({ name: list[sel].name, value: "", cursor: 0 });
    if (key.escape || input === "`") return tmux.focusLast();
    // The highlight IS the view: moving it switches the client to that project's session
    // (its own panel takes over, highlighting itself). A down project waits for Enter.
    if (key.upArrow || key.downArrow) {
      const next = key.upArrow ? Math.max(0, sel - 1) : Math.min(list.length - 1, sel + 1);
      setSel(next);
      const r = list[next];
      if (r && r.state !== "DOWN" && r.name !== session) {
        try { tmux.switchTo(r.name); tmux.focusPanel(r.name); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); }
      }
      return;
    }
    if (key.return && list[sel]) {
      const r = list[sel];
      try {
        if (r.state === "DOWN") {
          setMsg(`starting ${r.name}...`);
          core.up(r.name);
        }
        tmux.switchTo(r.name);
        if (r.name === session) tmux.focusLast();
      } catch (e) {
        setMsg(String(e instanceof Error ? e.message : e));
      }
    }
  });

  const w = Math.max(10, width - 2);
  const fit = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s.padEnd(n));
  return (
    <Box flexDirection="column" height={height} width={width} paddingX={1}>
      <Text bold>projects{sizeMark(seq)}</Text>
      {list.slice(Math.max(0, sel - height + 4), Math.max(0, sel - height + 4) + height - 3).map((r, i) => {
        const idx = i + Math.max(0, sel - height + 4);
        const on = idx === sel;
        const c = projectColor(r.name, r.color).ink;
        return (
          <Box key={r.name}>
            <Text backgroundColor={c}> </Text>
            <Text color={stateColor(r.state)}> {stateMark(r.state)}</Text>
            <Text inverse={on} color={on ? undefined : c} bold={r.name === session}>{fit(` ${r.name}`, w - 6)}</Text>
            <Text dimColor>{String(r.peers).padStart(2)}</Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {add ? (
        <Box flexDirection="column">
          <Text color="yellow">add to {add.name}:</Text>
          <Box>
            <Text>{add.value.slice(0, add.cursor)}</Text>
            <Text inverse>{add.cursor < add.value.length ? add.value[add.cursor] : " "}</Text>
            <Text>{add.value.slice(add.cursor + 1)}</Text>
            {add.cursor === add.value.length && <Text dimColor>{predict(add.value, candidates("add"), false)}</Text>}
          </Box>
        </Box>
      ) : (
        <Text dimColor>{msg || "↑↓ view  ↵ enter  a add  esc back  q close"}</Text>
      )}
    </Box>
  );
}

const session = process.env.MY_CLAUDE_PANEL_SESSION || tmux.currentSession()?.replace(/^mc-/, "") || "";

// Never outlive the terminal: a pane killed or replaced (respawn-pane) sends HUP and
// closes the pty; without this the process spins on a dead stdin/stdout.
const bail = () => { try { process.stdout.write("\x1b[?1049l"); } catch { /* gone */ } process.exit(0); };
for (const sig of ["SIGHUP", "SIGTERM"] as const) process.on(sig, bail);
process.stdin.on("end", bail); process.stdin.on("error", bail); process.stdout.on("error", bail);
process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J");
const app = render(<Panel session={session} />, { exitOnCtrlC: false });
await app.waitUntilExit();
process.stdout.write("\x1b[?1049l");
