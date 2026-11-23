# my-claude: rules for working on this repo

- **The GUI thread never waits on I/O.** In the window (host/), no network, subprocess,
  socket or D-Bus call that blocks: start it on another thread or as an asynchronous
  request, and let the result arrive as a message (a signal, a protocol request) that
  updates the window. The driver (src/gui.ts) follows the same rule for its event loop: no
  spawnSync, no awaited fetch before a dialog opens. Show the dialog, load behind it, fill
  it in (the `fill` request), and keep the last result cached so it shows at once.
  The only waits allowed are at teardown, when the window is going away.
- **A list with details is a table:** each detail a column, sortable by its header (the
  form's `table` and `picker` formats: `columns`, `enumRows`, `sort`). Dates as
  `YYYY-MM-DD HH:MM`, so they sort as text.
- Comments: one or two lines, why not what; history goes in the commit message.
- **The README's pictures come from the sandbox the UI tests use**, never from a real
  machine. A change to what the window shows refreshes them in the same commit:
  `tests/gui-demo.sh docs` (docs/gui.png, docs/overview.png); a change to the terminal UI:
  `tests/demo.sh` (docs/demo/*.gif, docs/screenshot.png).
- Nothing specific to one employer or person in this public repo: their profiles live in
  ~/.config/my-claude/profiles/.
