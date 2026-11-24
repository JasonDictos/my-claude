# Where my-claude is going

A running story, newest thinking first. my-claude is a sketchpad: features land on a
branch each, as a draft PR, with their design here beside this file.

## The agents get the window

Today the agents are Claude sessions in panes; the window is the user's. The direction
is that each agent can use the window too: show the user something, ask about it, and
take the answer back, without the user copying text between the two.

- **Plan review** (first step, [design](2026-11-24-plan-review.md)): an agent that
  writes a plan opens it over its pane; the user highlights a passage, asks, and the
  agent gets the question with the exact lines.
- **Paths in panes** open with Ctrl+click, from the pane's folder: a plan in the review
  panel, anything else in its desktop app.
- **A token per agent**: each agent gets a credential for the window's API, so the
  window knows who asks, and an agent gets richer interaction and window control
  (panels, focus, its own notices) than a file drop allows.
- **HTML assets** later, rendered the way the rest is: inside the binary (an embedded
  lynx), not by a system browser.

## One static binary

No system dependencies, no Linux dependency hell: one static executable that acts as
several programs by the name or prefix it is called with (`my-claude lynx …`). rpm and
deb packages are adapters only: they set up what the backend needs and install aliases
and desktop launchers. Launchers can be per profile, browser-style: a window per
profile, each its own process. Open: whether each profile then needs its own backend,
or the service holds them all.
