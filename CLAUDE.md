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
- Nothing specific to one employer or person in this public repo: their profiles live in
  ~/.config/my-claude/profiles/.
