// The side panel: a tmux popup docked left listing every project and, for the ones
// that are up, their peers. Enter switches the client there; Esc/q/` closes.
import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import * as core from "../core.ts";
import * as tmux from "../tmux.ts";
import { projectColor } from "../colors.ts";

type Row =
  | { kind: "project"; name: string; state: string; color: string | null; peers: number }
  | { kind: "peer"; name: string; repo: string; state: string; lead: boolean };

function rows(): Row[] {
  const out: Row[] = [];
  for (const p of core.ls()) {
    out.push({ kind: "project", name: p.name, state: p.state, color: p.color, peers: p.peers });
    if (p.state === "DOWN") continue;
    const s = core.status(p.name);
    for (const peer of s.peers) out.push({ kind: "peer", name: p.name, repo: peer.repo, state: peer.state, lead: s.lead === peer.repo });
  }
  return out;
}

const mark = (s: string) => (s === "live" ? "●" : s === "occupied" ? "!" : s === "starting" ? "◐" : s === "idle" ? "◌" : "○");
const markColor = (s: string) => (s === "live" ? "green" : s === "occupied" ? "red" : s === "starting" || s === "idle" ? "yellow" : "gray");

function Panel({ width, height, current }: { width: number; height: number; current: { name: string; repo: string } | null }) {
  const { exit } = useApp();
  const [list, setList] = useState<Row[]>(() => rows());
  const [sel, setSel] = useState(() => {
    const l = rows();
    const i = l.findIndex((r) => r.kind === "peer" ? r.name === current?.name && r.repo === current?.repo : r.name === current?.name && !current?.repo);
    return i < 0 ? Math.max(0, l.findIndex((r) => r.name === current?.name)) : i;
  });
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const t = setInterval(() => setList(rows()), 2000);
    return () => clearInterval(t);
  }, []);

  useInput((input, key) => {
    if (key.escape || input === "q" || input === "`" || (key.ctrl && input === "c")) return exit();
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSel((s) => Math.min(list.length - 1, s + 1));
    if (key.return && list[sel]) {
      const r = list[sel];
      try {
        if (r.kind === "project" && r.state === "DOWN") {
          setMsg(`starting ${r.name}...`);
          core.up(r.name);
        }
        tmux.switchTo(r.name, r.kind === "peer" ? r.repo : undefined);
        exit();
      } catch (e) {
        setMsg(String(e instanceof Error ? e.message : e));
      }
    }
  });

  const w = Math.max(10, width - 2);
  const fit = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s.padEnd(n));
  return (
    <Box flexDirection="column" height={height} width={width} paddingX={1}>
      <Text bold>projects</Text>
      {list.slice(Math.max(0, sel - height + 4), Math.max(0, sel - height + 4) + height - 3).map((r, i) => {
        const idx = i + Math.max(0, sel - height + 4);
        const on = idx === sel;
        if (r.kind === "project") {
          const c = projectColor(r.name, r.color).ink;
          const here = current?.name === r.name;
          return (
            <Box key={`p:${r.name}`}>
              <Text backgroundColor={c} color="black"> </Text>
              <Text inverse={on} color={on ? undefined : c} bold={here}>{fit(` ${r.name}`, w - 7)}</Text>
              <Text dimColor>{` ${r.state === "UP" ? "up" : r.state === "DOWN" ? "down" : "part"}`}</Text>
            </Box>
          );
        }
        const here = current?.name === r.name && current?.repo === r.repo;
        return (
          <Box key={`r:${r.name}/${r.repo}`}>
            <Text>   </Text>
            <Text color={markColor(r.state)}>{mark(r.state)}</Text>
            <Text inverse={on} bold={here}>{fit(` ${r.repo}${r.lead ? "★" : ""}`, w - 4)}</Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>{msg || "↑↓ Enter switch · Esc close"}</Text>
    </Box>
  );
}

const width = Number(process.env.MY_CLAUDE_PANEL_W || process.stdout.columns || 34);
const height = Number(process.stdout.rows || 24);
process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J");
const app = render(<Panel width={width} height={height} current={tmux.activePeer()} />, { exitOnCtrlC: false });
await app.waitUntilExit();
process.stdout.write("\x1b[?1049l");
