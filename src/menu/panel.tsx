// The side panel: a pane docked left in every project session listing the projects.
// Enter switches the client there, Esc hands focus back to the pane you came from,
// q closes the panel.
import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import * as core from "../core.ts";
import * as tmux from "../tmux.ts";
import { projectColor } from "../colors.ts";

type Row = { name: string; state: string; color: string | null; peers: number };

const rows = (): Row[] => core.ls().map((p) => ({ name: p.name, state: p.state, color: p.color, peers: p.peers }));
const stateMark = (s: string) => (s === "UP" ? "●" : s === "PARTIAL" ? "◐" : "○");
const stateColor = (s: string) => (s === "UP" ? "green" : s === "PARTIAL" ? "yellow" : "gray");

function Panel({ session }: { session: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns ?? 30, height: stdout.rows ?? 24 });
  useEffect(() => {
    // Ink only erases what it last drew; a shrunken pane keeps the old frame above. Wipe first.
    const onResize = () => { stdout.write("\x1b[2J\x1b[H"); setSize({ width: stdout.columns ?? 30, height: stdout.rows ?? 24 }); };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  const { width, height } = size;

  const [list, setList] = useState<Row[]>(() => rows());
  const [sel, setSel] = useState(() => Math.max(0, rows().findIndex((r) => r.name === session)));
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const t = setInterval(() => setList(rows()), 2000);
    return () => clearInterval(t);
  }, []);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (key.escape || input === "`") return tmux.focusLast();
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSel((s) => Math.min(list.length - 1, s + 1));
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
      <Text bold>projects</Text>
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
      <Text dimColor>{msg || "↵ switch  esc back  q close"}</Text>
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
