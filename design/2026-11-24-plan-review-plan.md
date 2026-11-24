# Plan review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent (or the user, by `/review-plan <path>`) opens a plan over the agent's pane; the user selects a passage, asks, and the agent gets the question with the quoted lines in its prompt.

**Architecture:** `my-claude review <path>` (run inside the agent) drops a request file under the project folder; the driver, which polls every 1.5 s, picks it up, reads the plan and sends it to the window, which floats it in a `QTextBrowser` panel over the agent's tab. A question goes back as an event; the driver maps the selection to source lines and pastes a `[review]` block into the agent's pane through tmux.

**Tech Stack:** TypeScript on bun (driver, CLI), Qt 6 widgets (window), tmux.

**Spec:** `design/2026-11-24-plan-review.md`

## Global Constraints

- The GUI thread and the driver loop never wait on I/O: the driver uses `node:fs/promises` for everything this feature reads or stats.
- Comments are brief and say why.
- The repo is public: nothing employer-specific in code, tests, docs or commits.
- Long test runs: foreground, `|& tee <log>`, never filtered.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` only.
- One panel per agent; HTML, batched comments and editing in the panel are out of scope.

Commands used below: `bunx tsc --noEmit -p .` (typecheck), `bun test tests/review.test.ts`, `cmake --build host/build`, `bash tests/gui.sh |& tee $LOG/gui-e2e.log`, `bash tests/smoke.sh |& tee $LOG/smoke.log` (`$LOG`: the session scratchpad).

## Review Focus

1. A request for a path the driver cannot see (the agent's container sees another filesystem): the user is told, nothing silently happens. Test in Task 4.
2. A selection across Markdown formatting (heading `#`, `**bold**`, list bullets, inline code): still mapped to the right source lines; a selection found nowhere still goes, without line numbers. Tests in Task 1.
3. A second plan for the same agent replaces the first in its panel. Test in Task 4.
4. A request while the agent's project has no tab in front: the project's tab comes to the front with the panel. Test in Task 4.
5. The plan edited by the agent after a question: the panel shows the new text, at the same scroll. Test in Task 4 (text; scroll is the builder's care).

---

### Task 1: review.ts, the pure parts

**Files:**
- Create: `src/review.ts`
- Test: `tests/review.test.ts`

**Interfaces:**
- Produces: `selectionLines(source: string, selection: string): [number, number] | null` (1-based, inclusive); `reviewMessage(path: string, lines: [number, number] | null, selection: string, question: string): string`.

- [ ] **Step 1: Write the failing tests** (`bun:test`)

```ts
const src = "# Plan\n\n## Task 3: Reactors\n\n- One **reactor** per disk\n- `io_uring` engine\n\nDone.\n";
test("a plain line maps to itself", () => expect(selectionLines(src, "Done.")).toEqual([8, 8]));
test("formatting in the source does not hide it", () => expect(selectionLines(src, "One reactor per disk")).toEqual([5, 5]));
test("a selection over several lines spans them", () => expect(selectionLines(src, "Task 3: Reactors\nOne reactor per disk\nio_uring engine")).toEqual([3, 6]));
test("part of a line is that line", () => expect(selectionLines(src, "reactor per")).toEqual([5, 5]));
test("text that is not there has no lines", () => expect(selectionLines(src, "nowhere at all")).toBeNull());
test("the block the agent gets", () => expect(reviewMessage("docs/plan.md", [5, 6], "One reactor per disk\nio_uring engine", "why per disk?")).toBe("[review] docs/plan.md:5-6\n> One reactor per disk\n> io_uring engine\nwhy per disk?"));
test("one line, no range", () => expect(reviewMessage("docs/plan.md", [5, 5], "One reactor", "why?")).toBe("[review] docs/plan.md:5\n> One reactor\nwhy?"));
test("no lines found: the path alone", () => expect(reviewMessage("docs/plan.md", null, "x", "why?")).toBe("[review] docs/plan.md\n> x\nwhy?"));
```

- [ ] **Step 2: Run** `bun test tests/review.test.ts`. Expected: FAIL, cannot find `../src/review.ts`.

- [ ] **Step 3: Implement both in `src/review.ts`.** `selectionLines`: normalise each source line and each non-empty selection line the same way (drop `#` heading marks, list markers `-`/`+`/`*`/`1.` at the start, the characters `*` `_` and backtick, collapse whitespace, trim); the first selection line maps to the first source line containing it, the last to the first source line at or after that containing it; null when the first is not found.

- [ ] **Step 4: Run** `bun test tests/review.test.ts`. Expected: 8 pass.

- [ ] **Step 5: Commit** `src/review.ts tests/review.test.ts`: "review: map a selection in a rendered plan to its source lines".

### Task 2: `my-claude review <path>`

**Files:**
- Modify: `src/review.ts`, `src/cli.ts` (a `case "review"` beside `case "brief"`, and its usage line)
- Test: `tests/smoke.sh`

**Interfaces:**
- Produces: `requestReview(name: string, repo: string, path: string): string` (absolute path; writes it to `PROJECTS/<name>/.review/<repo>`; `die` when the path is not a file); `takeReviewRequests(name: string): Promise<{ repo: string; path: string }[]>` (reads and removes the files, async).
- `my-claude review <path>` takes the project and agent from `MY_CLAUDE_PROJECT` / `MY_CLAUDE_PEER` and dies without them: "review runs inside an agent (MY_CLAUDE_PROJECT and MY_CLAUDE_PEER unset)".

- [ ] **Step 1: Write the failing smoke checks** (after the `brief` checks, project `smoke`, agent `r1`):

```bash
mkdir -p "$tmp/r1/docs"; echo "# plan" > "$tmp/r1/docs/plan.md"
(cd "$tmp/r1" && MY_CLAUDE_PROJECT=smoke MY_CLAUDE_PEER=r1 mc review docs/plan.md >/dev/null) || fail "review should take a plan"
[ "$(cat "$MY_CLAUDE_ROOT/projects/smoke/.review/r1")" = "$tmp/r1/docs/plan.md" ] || fail "review should leave the plan's path for the window"
(cd "$tmp/r1" && MY_CLAUDE_PROJECT=smoke MY_CLAUDE_PEER=r1 mc review docs/nope.md >/dev/null 2>&1) && fail "review of a missing file should fail"
(cd "$tmp/r1" && mc review docs/plan.md >/dev/null 2>&1) && fail "review outside an agent should fail"
rm -rf "$MY_CLAUDE_ROOT/projects/smoke/.review"
```

- [ ] **Step 2: Run smoke.** Expected: FAIL at "review should take a plan" (unknown command).
- [ ] **Step 3: Implement** `requestReview`, `takeReviewRequests` and the CLI case.
- [ ] **Step 4: Run smoke and typecheck.** Expected: `smoke OK`, tsc clean.
- [ ] **Step 5: Commit**: "my-claude review <path>: an agent asks the window to show a plan".

### Task 3: the plan panel in the window

**Files:**
- Create: `host/src/planpanel.h`, `host/src/planpanel.cpp` (and add `planpanel.cpp` to `host/CMakeLists.txt` sources)
- Modify: `host/src/host.h`, `host/src/host.cpp` (ops, list, layout), `host/PROTOCOL.md`
- Test: `tests/gui-e2e.ts`

**Interfaces (protocol, documented in PROTOCOL.md):**
- op `plan` `{id, tab, path, agent, text}`: show (or update, keeping the scroll) the panel for agent pane `id` (`<project>/<pane>`) over tab `tab`, titled `path`, rendering `text` as Markdown; its ask box reads "Ask <agent> about the selection".
- op `plan-close` `{id}`.
- ev `plan-ask` `{id, path, selection, question}`: Enter in the ask box with text selected (paragraph separators U+2029 as `\n`); the box clears.
- ev `plan-closed` `{id}`: its ✕.
- list: `plans: [{id, tab, path, visible, text}]` (`text`: the rendered plain text).
- test op `plan-select` `{id, text}`: selects the first occurrence of `text` and puts the keyboard in the ask box, as a drag and a click would.

`PlanPanel : QFrame` (a `Qt::SubWindow` child of `center_`, like the consoles' panel): a title bar (path; drag to move; ✕), a `QTextBrowser` (`setMarkdown`), a `QLineEdit` ask box, a `QSizeGrip`; signals `asked(QString selection, QString question)` and `closed()`. Host keeps `QMap<QString, PlanPanel*> plans_`; `layoutPlans()` (called at the end of `layoutDocks()`) shows each over its tab only, kept on the view, below the consoles' panel.

- [ ] **Step 1: Write the failing e2e** (after the consoles section, demo in front):

```ts
// a plan over an agent's pane: shown over its tab only; a question comes back with the selection
u.send({ op: "plan", id: r1.id, tab: "demo", path: "docs/plan.md", agent: "r1", text: "# Plan\n\n## Task 3\n\n- One **reactor** per disk\n" });
await u.shows("the plan over demo", (x) => x.plans?.some((p: any) => p.id === r1.id && p.visible && p.text.includes("One reactor per disk")));
u.send({ op: "plan-select", id: r1.id, text: "reactor per disk" });
for (const c of "why?") await key(c);
await key("Return");
const ask = await u.until("plan-ask");
if (ask.id !== r1.id || ask.selection !== "reactor per disk" || ask.question !== "why?") fail("the question should come back with the selection", ask);
u.send({ op: "plan", id: r1.id, tab: "demo", path: "docs/plan.md", agent: "r1", text: "# Plan\n\n- Two reactors\n" });
await u.shows("the plan updated in place", (x) => x.plans?.length === 1 && x.plans[0].text.includes("Two reactors"));
u.send({ op: "tab", tab: "second-one", focus: true });
await u.shows("not over another project", (x) => x.current === "second-one" && !x.plans[0].visible);
u.send({ op: "tab", tab: "demo", focus: true });
u.send({ op: "plan-close", id: r1.id });
await u.shows("closed", (x) => !x.plans?.length);
```

(Place it where `second-one` exists, i.e. after the New project section; `r1` is demo's first pane as found there.)

- [ ] **Step 2: Build and run e2e.** Expected: FAIL "unknown op plan".
- [ ] **Step 3: Implement** PlanPanel, the ops, the list entry, `layoutPlans()`, PROTOCOL.md.
- [ ] **Step 4: Build, run e2e.** Expected: `gui e2e OK`.
- [ ] **Step 5: Commit**: "A plan panel over an agent's pane: Markdown, select and ask".

### Task 4: the driver: requests, questions, reloads, Ctrl+click

**Files:**
- Modify: `src/gui.ts` (state, `look()`, `onEvent`, `openPath`), `src/tmux.ts`
- Test: `tests/gui-e2e.ts`

**Interfaces:**
- Consumes: Task 1 `selectionLines`, `reviewMessage`; Task 2 `takeReviewRequests`; Task 3 ops and events.
- Produces: `tmux.paste(pane: string, text: string): Promise<void>` (`set-buffer -b mc-review`, `paste-buffer -p -d -b mc-review -t <pane>`, then `send-keys Enter`); in `Gui`: `plans: Map<string, { name: string; repo: string; path: string; mtime: number }>` keyed by the agent's term id, and `openPlan(name: string, repo: string, abs: string): Promise<void>`.

Behaviour: each `look()` takes every project's requests and opens them; `openPlan` finds the agent's pane (not running: notify "<repo> is not running"), reads the file (missing: notify "no <path> here (<repo>'s plan is in its own filesystem?)"), sends op `plan` with `path` relative to the agent's repo, brings the project's tab to the front (`show(name)`), remembers mtime; each `look()` stats open plans and resends on a new mtime; `plan-ask` pastes `reviewMessage(...)` into the agent's pane; `plan-closed` forgets it; `openPath` on a `.md` in an agent's pane (or a shell of that agent) opens the plan panel instead of the desktop app.

- [ ] **Step 1: Write the failing e2e** (demo up, r1 an agent in `$E2E_TMP/r1`):

```ts
// review end to end: asked for from inside r1, a question lands in r1's pane, an edit reloads
const plan = join(tmp, "r1/docs/plan.md");
mkdirSync(dirname(plan), { recursive: true }); writeFileSync(plan, "# Plan\n\n## Task 3\n\n- One **reactor** per disk\n");
const review = (p: string) => Bun.spawnSync(["bun", join(root, "src/cli.ts"), "review", p], { cwd: join(tmp, "r1"), env: { ...process.env, MY_CLAUDE_PROJECT: "demo", MY_CLAUDE_PEER: "r1" } });
u.send({ op: "tab", tab: "second-one", focus: true });
review("docs/plan.md");
await u.shows("the plan over r1, demo in front", (x) => x.current === "demo" && x.plans?.some((p: any) => p.path === "docs/plan.md" && p.visible));
u.send({ op: "plan-select", id: r1.id, text: "reactor per disk" });
for (const c of "why?") await key(c);
await key("Return");
await until(async () => (await screenOf(r1.id)).includes("[review] docs/plan.md:5"), "the question in r1's pane, with the line");
writeFileSync(plan, "# Plan\n\n- Two reactors\n");
await u.shows("the agent's edit shown", (x) => x.plans[0].text.includes("Two reactors"));
mkdirSync(join(tmp, "r1/docs2"), { recursive: true }); writeFileSync(join(tmp, "r1/docs2/other.md"), "# Other\n");
review("docs2/other.md");
await u.shows("a second plan replaces the first", (x) => x.plans.length === 1 && x.plans[0].path === "docs2/other.md");
u.send({ op: "plan-close", id: r1.id });
await u.shows("closed", (x) => !x.plans?.length);
// a request for a path the driver cannot read (another filesystem): no panel, the request used up
writeFileSync(join(root, "projects/demo/.review/r1"), join(tmp, "r1/not-here.md"));
for (let i = 0; i < 40 && existsSync(join(root, "projects/demo/.review/r1")); i++) await Bun.sleep(100);
if (existsSync(join(root, "projects/demo/.review/r1")) || (await u.list()).plans?.length) fail("an unreadable plan should be said, not shown or left waiting");
```

and, with r1's pane showing a `.md` path (send `docs/plan.md` into it with op `send`; the stub echoes it), a Ctrl+click on it (op `mouse`) opens the panel, not the desktop app (`opened` unchanged). (`until`: poll a predicate up to 10 s, else fail with the message; add it beside `screenOf` if the file has none.)

- [ ] **Step 2: Run e2e.** Expected: FAIL at "the plan over r1".
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Typecheck, run e2e.** Expected: clean, `gui e2e OK`.
- [ ] **Step 5: Commit**: "Plan review end to end: requests, questions into the agent's prompt, reloads, Ctrl+click".

### Task 5: the skill, installing it, and the agents' brief

**Files:**
- Create: `skills/review-plan/SKILL.md`
- Modify: `src/cli.ts` (`install --skills`), `src/core.ts` (`projectBrief`: one line), `README.md` (a bullet), `design/2026-11-24-plan-review.md` (tick)
- Test: `tests/smoke.sh`

**Interfaces:**
- `my-claude install --skills`: for each directory in `ROOT/skills`, a symlink `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<name>` → it; an existing link is replaced, a real directory there is left alone with a warning; prints what it linked.
- Brief line (exact): ``When you hand the user a plan or spec you wrote, run `"$MY_CLAUDE_ROOT/bin/my-claude" review <path>` (the review-plan skill does the same): it opens over your pane, the user highlights a passage and asks, and the question reaches you as a "[review] <path>:<lines>" block quoting it. Answer about exactly those lines; edit the plan only when the user agrees.``
- SKILL.md: name `review-plan`; description "Use when the user types /review-plan <path>, or when you have written a plan or spec and are handing it over for review"; body: run the command above, tell the user it is open, then handle `[review]` blocks: quote, answer from the file and code, edit on agreement (the panel reloads on save), keep a list of decisions, edits and open questions, and at the end ask whether to carry out the plan.

- [ ] **Step 1: Write the failing smoke checks:**

```bash
mc install --skills >/dev/null
[ -L "$HOME/.claude/skills/review-plan" ] && [ "$(readlink "$HOME/.claude/skills/review-plan")" = "$MY_CLAUDE_ROOT/skills/review-plan" ] || fail "install --skills should link review-plan"
mc install --skills >/dev/null || fail "install --skills twice"
grep -q 'review <path>' "$FAKE_CLAUDE_LOG" || fail "the brief should tell agents about plan review"
```

(The brief check goes after a launch, where `$FAKE_CLAUDE_LOG` holds the argv; `$MY_CLAUDE_ROOT/skills` must resolve: the smoke root links `src` and `bin`, add `skills` the same way in `tests/smoke.sh` and `tests/gui.sh`.)

- [ ] **Step 2: Run smoke.** Expected: FAIL at "install --skills should link review-plan".
- [ ] **Step 3: Implement**, README bullet ("Plan review: …"), tick the design's checklist in the PR.
- [ ] **Step 4: Run smoke, e2e, typecheck.** Expected: all green.
- [ ] **Step 5: Commit**: "The review-plan skill, my-claude install --skills, and the agents told".
