// MCP server over stdio for the Claudes my-claude runs: start a project instead of a
// subagent. Hand-rolled JSON-RPC (newline-delimited), the handful of methods Claude
// Code uses. Which session is calling comes from MY_CLAUDE_PROJECT/MY_CLAUDE_PEER.
import * as core from "./core.ts";
import { UsageError } from "./store.ts";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run: (a: Record<string, any>) => Promise<string> | string };

const caller = () => (process.env.MY_CLAUDE_PROJECT && process.env.MY_CLAUDE_PEER ? `${process.env.MY_CLAUDE_PROJECT}/${process.env.MY_CLAUDE_PEER}` : null);

const TOOLS: Tool[] = [
  {
    name: "start_project",
    description:
      "Start a new my-claude project: a durable, user-visible set of Claude Code sessions, one per repo, in their own tmux session with a side panel entry. Use this instead of subagents whenever a piece of work deserves its own long-lived sessions (a new idea discussed with the user, work in other repos, anything that should survive this conversation). The work order becomes the project goal, every session's system prompt, and the lead's first prompt, so the lead starts working at once and can brief the others. They can reach you back through claude-peers.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short project name (slug: letters, digits, . _ -)" },
        repos: { type: "array", items: { type: "string" }, minItems: 1, description: "One spec per repo: an existing path, org/repo, a git or PR URL; optional '--branch B' or '--name N' after a spec" },
        work_order: { type: "string", description: "What the project is to achieve and how far to take it. Written for the lead session, which sees nothing of this conversation." },
        lead: { type: "string", description: "Repo name of the lead (default: the first repo)" },
        color: { type: "string", description: "Panel color name (optional)" },
        shared: { type: "boolean", description: "One shared container for all repos instead of one per repo" },
      },
      required: ["name", "repos", "work_order"],
    },
    run: async (a) => {
      const r = await core.startProject({ name: a.name, repos: a.repos, workOrder: a.work_order, lead: a.lead, color: a.color, shared: a.shared, by: caller() ?? undefined });
      return [`project ${r.name} is up: ${r.peers.join(", ")}; lead ${r.lead}.`, `The lead got the work order as its first prompt. Message the claude-peers group "${r.name}" to talk to them.`, ...r.notes].join("\n");
    },
  },
  {
    name: "add_repos",
    description: "Add repos to an existing my-claude project (a session per repo is started if the project is up).",
    inputSchema: { type: "object", properties: { project: { type: "string" }, repos: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["project", "repos"] },
    run: async (a) => {
      const peers = await core.addRepos(a.project, a.repos.join(" "));
      if (core.ls().find((p) => p.name === a.project)?.state !== "DOWN") core.up(a.project);
      return `added ${peers.map((p) => `${p.repo} (${p.path})`).join(", ")} to ${a.project}`;
    },
  },
  {
    name: "list_projects",
    description: "List my-claude projects with their state and goal.",
    inputSchema: { type: "object", properties: {} },
    run: () => JSON.stringify(core.ls().map((p) => ({ name: p.name, state: p.state, peers: p.peers, lead: p.lead, goal: p.goal, needs: p.attn })), null, 2),
  },
  {
    name: "project_status",
    description: "Peers of a my-claude project: repo, path, role, liveness, whether each one is waiting on the user.",
    inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    run: (a) => {
      const s = core.status(a.project);
      return JSON.stringify({ name: s.name, state: s.state, goal: s.goal, lead: s.lead, by: s.by ?? null, peers: s.peers.map((p) => ({ repo: p.repo, path: p.path, role: p.role, live: p.state, needs: p.attn })) }, null, 2);
    },
  },
];

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(req: { id?: unknown; method: string; params?: any }): Promise<void> {
  const { id, method, params } = req;
  if (method.startsWith("notifications/")) return;
  try {
    let result: unknown;
    if (method === "initialize") result = { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "my-claude", version: "1" } };
    else if (method === "ping") result = {};
    else if (method === "tools/list") result = { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    else if (method === "tools/call") {
      const t = TOOLS.find((x) => x.name === params?.name);
      if (!t) throw new UsageError(`no tool '${params?.name}'`);
      try {
        result = { content: [{ type: "text", text: await t.run(params?.arguments ?? {}) }] };
      } catch (e) {
        result = { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    } else return void (id !== undefined && send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } }));
    if (id !== undefined) send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
  }
}

export async function serve(): Promise<number> {
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += Buffer.from(chunk).toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        await handle(JSON.parse(line));
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
    }
  }
  return 0;
}

// What --mcp-config gets: this server, through the wrapper that works on host and in containers.
export function mcpConfig(root: string, configDir: string): string {
  return JSON.stringify({ mcpServers: { "my-claude": { command: `${root}/bin/my-claude`, args: ["mcp"], env: { MY_CLAUDE_ROOT: root, MY_CLAUDE_CONFIG_DIR: configDir } } } });
}
