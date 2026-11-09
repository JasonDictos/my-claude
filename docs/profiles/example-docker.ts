// Example external profile: every peer runs `claude` inside a Docker container
// built from the repo's own Dockerfile, with the repo bind-mounted at the same path.
// Drop this file in ~/.config/my-claude/profiles/docker.ts and set "profile": "docker"
// in ~/.config/my-claude/config.json (or pass --profile docker to `my-claude new`).
//
// A profile module's default export is a factory: it receives the core's helpers
// and returns a Profile. Type imports may point at your my-claude checkout.
import type { LaunchCtx, Profile, ProfileApi } from "../../src/profiles/types.ts";

export default function dockerProfile({ run, out }: ProfileApi): Profile {
  const image = (ctx: LaunchCtx) => `mc-${ctx.repo}`;

  const build = (ctx: LaunchCtx) => run("docker", ["build", "-q", "-t", image(ctx), ctx.path]);

  // The container's shell runs claude first and stays up when it exits, so a
  // double Ctrl-C lands at a prompt and my-claude can type `claude` back in.
  const shellWith = (ctx: LaunchCtx) => `${ctx.cmdline}; exec bash -i`;

  return {
    launch(ctx) {
      if (build(ctx) !== 0) return 1;
      const args = ["run", "--rm", "-it", "-v", `${ctx.path}:${ctx.path}`, "-v", `${process.env.HOME}/.claude:/root/.claude`, "-w", ctx.path];
      if (ctx.mode === "shared") args.push("--name", ctx.container);
      return run("docker", [...args, image(ctx), "bash", "-ic", shellWith(ctx)]);
    },
    // Shared mode, peers 2..n: join the container the first peer started.
    exec(ctx) {
      return run("docker", ["exec", "-it", "-w", ctx.path, ctx.container, "bash", "-ic", shellWith(ctx)]);
    },
    containerReady(container) {
      return out("docker", ["inspect", "-f", "{{.State.Running}}", container], { ok: true }) === "true";
    },
    // prefix+h: a shell in the peer's own container (my-claude passes the id it found).
    shellInto(container, path) {
      if (!container) return run("bash", [], { cwd: path });
      return run("docker", ["exec", "-it", "-w", path, container, "bash"]);
    },
    // Panes start from the tmux server's environment; pass what docker needs.
    paneEnv() {
      const env: Record<string, string> = {};
      if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
      return env;
    },
    // Optional: hotkeys on the projects screen. This one files nothing, it just
    // shows the shape: prompts, then an async run that may create a project.
    actions: [
      {
        key: "T",
        label: "New from ticket",
        prompts: [{ label: "Ticket id" }, { label: "Summary" }],
        async run([id, summary]) {
          if (!id) return { message: "no ticket id" };
          return { message: `project for ${id}`, createProject: { name: id.toLowerCase(), goal: `${id}: ${summary}` } };
        },
      },
    ],
  };
}
