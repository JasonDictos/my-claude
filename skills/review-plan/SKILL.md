---
name: review-plan
description: Use when the user types /review-plan <path>, or when you have written a plan or spec and are handing it over for review - in a my-claude window it opens over your pane, where the user highlights passages and asks you about them.
---

# /review-plan <path> - the user reviews a plan over your pane

1. Run `"$MY_CLAUDE_ROOT/bin/my-claude" review <path>` (no path given: the plan or spec you
   just wrote). The window floats it over your pane; say so in one line, with the path.
2. Wait. The user selects a passage and asks; it reaches you in your prompt as

   ```
   [review] docs/plans/x.md:88-90
   > the passage, quoted
   their question
   ```

   No lines and no quote: the question is about the plan as a whole.
3. Answer about exactly those lines: read them again in the file (it may have changed since),
   and check what you say about the code in the code.
4. A change they ask for: say what you would change, and edit the file once they agree. The
   panel reloads when the file is saved.
5. Keep a short list as you go: decisions, edits (with lines), open questions. When they are
   done, give it, and ask whether to carry out the plan.

Outside my-claude (`$MY_CLAUDE_ROOT` unset) there is no panel: print the plan's outline with
line ranges and ask the user to point at passages by number or range instead.
