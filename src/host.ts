// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Talking to the native app (host/, "mc-term"): newline-delimited JSON over a Unix socket.
// The protocol is in host/PROTOCOL.md; this is the client side every my-claude process uses.
import { connect, type Socket } from "node:net";

export const defaultSocket = (): string => process.env.MC_TERM_SOCKET || `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/my-claude/host.sock`;

// One request, fire and forget. Resolves false when nobody listens there.
export function hostSend(msg: object, sock = defaultSocket()): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(sock);
    const done = (ok: boolean) => { c.destroy(); resolve(ok); };
    c.setTimeout(1500, () => done(false));
    c.on("error", () => done(false));
    c.on("connect", () => c.end(JSON.stringify(msg) + "\n", () => done(true)));
  });
}

export function hostAlive(sock = defaultSocket()): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(sock);
    const done = (ok: boolean) => { c.destroy(); resolve(ok); };
    c.setTimeout(800, () => done(false));
    c.on("error", () => done(false));
    c.on("connect", () => done(true));
  });
}

// A long-lived connection: every line the app sends arrives parsed, in order.
export interface HostLink {
  send(msg: object): void;
  close(): void;
  closed: Promise<void>;
}
// sock "-": the window is at the other end of stdin/stdout (a driver started over ssh).
export function hostLink(sock: string, onEvent: (ev: any) => void): Promise<HostLink> {
  if (sock === "-") return Promise.resolve(stdioLink(onEvent));
  return new Promise((resolve, reject) => {
    const c: Socket = connect(sock);
    let buf = "";
    let end!: () => void;
    const closed = new Promise<void>((r) => { end = r; });
    c.on("error", (e) => { reject(e); end(); });
    c.on("close", () => end());
    c.on("data", (d) => {
      buf += d.toString("utf8");
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        try { onEvent(ev); } catch (e) { console.error(`my-claude gui: handler failed: ${e instanceof Error ? e.stack ?? e.message : e}`); }
      }
    });
    c.on("connect", () => resolve({ send: (m) => { if (!c.destroyed) c.write(JSON.stringify(m) + "\n"); }, close: () => c.destroy(), closed }));
  });
}

function stdioLink(onEvent: (ev: any) => void): HostLink {
  let buf = "";
  let end!: () => void;
  const closed = new Promise<void>((r) => { end = r; });
  process.stdin.on("data", (d) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      try { onEvent(ev); } catch (e) { console.error(`my-claude gui: handler failed: ${e instanceof Error ? e.stack ?? e.message : e}`); }
    }
  });
  process.stdin.on("end", () => end());
  process.stdin.on("close", () => end());
  return { send: (m) => { process.stdout.write(JSON.stringify(m) + "\n"); }, close: () => { process.stdin.destroy(); end(); }, closed };
}
