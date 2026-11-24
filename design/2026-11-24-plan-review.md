# Plan review: an embedded skill for interactive prompting over a plan

Branch `feature/plan-review`. Story: [README](README.md).

## Why

An agent that finishes a plan says "saved to docs/…/plan.md, please review". The user
opens the file somewhere else, reads, and for every question re-types where in the
plan they are. The review should happen where the agent is: the plan beside it, the
user pointing at a passage and asking, the agent answering about exactly those lines.

## What the user sees

```
┌ project tab ─────────────────────────────────────────────┐
│ (the agent's pane)                                       │
│   ┌ docs/plans/2026-11-24-reactors.md            📌 ✕ ┐  │
│   │ ## Task 3: Reactors                               │  │
│   │ ░One reactor per disk░        ← the selection     │  │
│   ├───────────────────────────────────────────────────┤  │
│   │ Ask <agent>: why per disk, not per volume? ⏎       │  │
│   └───────────────────────────────────────────────────┘  │
```

What the agent gets, typed into its prompt as if the user had:

```
[review] docs/plans/2026-11-24-reactors.md:88-90
> One reactor per disk
why per disk, not per volume?
```

## How it starts

- `/review-plan <path>`: a skill my-claude provides. The user types it in an agent, and
  agents are told (in the brief every agent is launched with) to run it themselves when
  they hand over a plan or spec, instead of "please review".
- The skill runs `my-claude review <path>`, which knows its project and agent from the
  agent's environment (`MY_CLAUDE_PROJECT`, `MY_CLAUDE_PEER`).
- Ctrl+click on a `.md` path in a pane opens it in the same panel (other paths open in
  their desktop app; done on this branch).

## How it works

- `my-claude review` leaves a note in the project's folder; the driver, which already
  watches those folders for agent state, picks it up. A file drop works from inside an
  agent's container, where the window's socket is out of reach. (Later: the per-agent
  token API.)
- The driver reads the file and sends its text to the window; it watches the file and
  resends when the agent edits the plan.
- The window floats the plan over that agent's pane, like the consoles' panel (drag,
  size, pin, close), rendered by Qt (`QTextBrowser`, Markdown). No system tools.
- Asking: select text, type the question, Enter. The driver finds the selection's lines
  in the file and types the block above into the agent's pane. One question at a time;
  the answer comes in the agent's pane.

## Installing the skill

`my-claude install --skills` links my-claude's skills into `~/.claude/skills` (a link,
not a copy, so they follow the checkout); agents in containers see them where they see
the user's other skills. How skills get installed for good (plugin, link) is open.

## Not now

HTML (later, an embedded lynx), batched review comments, editing the plan in the panel,
the per-agent token API.
