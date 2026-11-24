# mc-term protocol (version 2)

`mc-term` is my-claude's native window, and deliberately dumb: tabs, a grid of
terminals, a tree, menus and form dialogs, all drawn from what a *driver* sends and all
reported back as events. It knows nothing of projects or peers. The driver is
`my-claude _gui`; the window starts it (`--driver`), restarts it when it dies, and holds
what the user does in the meantime.

Newline-delimited JSON over the Unix socket `$XDG_RUNTIME_DIR/my-claude/host.sock`
(`--socket` or `$MC_TERM_SOCKET` override). Any number of clients; every event goes to
all of them. Fields not listed are ignored. One window per socket: a second start
raises the first and leaves.

## Other machines

`mc-term --remote user@host` runs the window here and everything else there: the driver
as `my-claude _gui --stdio` in a login shell over ssh, speaking this protocol on its
stdin and stdout (bridged to a connection to the window's socket), and tmux as
`ssh user@host tmux …`, all on one multiplexed connection. Only native panes make sense
that way, and the driver insists on them.

One window can also hold several machines: `connect` starts another machine's driver the
same way, beside this machine's. Its projects, panes and tree entries come back tagged
`name@machine` (`m:<machine>` for a machine that cannot be reached), its tmux is reached
through its own ssh, and each driver sees only its own, untagged.

On the far side an allowed key reaches only `_remote-gate` (or the daemon's own ssh
endpoint), which runs the driver, `tmux -C attach-session`/`has-session` for `mc-*`
sessions and `my-claude-consoles`, and `my-claude --version|new|add|up|ls` as the window sends them, nothing else.

## Terminals

Two kinds, by what `open` carries:

- `argv`: a program run in the window on a pty of its own.
- `tmux: {session, pane, window}`: a **tmux pane shown natively**. The window attaches
  one control-mode client (`tmux -C`) per session, feeds the pane's raw output to a
  terminal widget and sends what is typed back with `send-keys -H`. tmux still owns
  the process: closing the window ends nothing.
  - The pane's state comes from tmux in one atomic batch (pause, capture scrollback,
    screen, the screen under an alternate one, cursor and modes, continue), so what is
    drawn is exactly what tmux holds, and output after it is neither lost nor doubled.
  - The widget's size is the pane's size (`resize-window`; the window is left
    `window-size manual`, so no other client moves it).
  - After every resize the widget is compared with tmux; if they differ (tmux rewraps,
    this widget only clips) the pane is read again.
  - Scrollback is the widget's own: unlimited by default, in unnamed files under
    `~/.cache/my-claude/scrollback`, capped in total (`look.scrollbackCapGB`).
  - A display that falls behind stops reading tmux's pipe; tmux then stops reading the
    pane and the program waits. Nothing is dropped, nothing piles up in memory. A window
    that stops altogether holds a program for five seconds at most: then tmux lets the
    pane run on without it (`pause-after`), and the pane is read again when the window
    is back (`fell-behind`).
  - Between tmux and the widget sits an adapter (`src/dialect.h`): queries tmux has
    already answered are dropped (the widget must not answer them again), so are
    strings the widget cannot take (DCS, APC, OSC 8/133/…), colon-form colours are
    rewritten, OSC 52 sets the clipboard, OSC 9/777 become `note` events.
  - A control client that is lost while its session lives is replaced in place; the
    terminals keep their scrollback (`reattached`).

## Consoles

A terminal opened with `tab` `_consoles` (`_consoles@<machine>` for another machine's) is
no project's: it goes into that machine's consoles panel, which floats over the tabs, always
above the panes, a tab per console. The panel is up over the views (project tabs) it was
shown on, or every one when pinned; it can be dragged, sized, minimised to its title and
maximised. Closing it takes it off the view in front, and its terminals stay open. Its
tabs ask the driver to close (`action` `pane.close`) or rename (`rename {id, name}`) a
console; `host.consoles` with no console there asks for one (`action` `console.new`).
`list` reports the panels as `consoles[]`: `{tab, count, visible, pinned, minimised,
maximised, shownIn[], current, tabs[]}`.

## Requests (client → window), `op`

| op | fields | effect |
|----|--------|--------|
| `driver` | | This client is the driver: it gets what the user did while none was listening. |
| `open` | `id`, `tab`, `title`, `color`, `node`, `attention`, `focus`, and `argv[]`+`cwd`+`env{}` or `tmux{session,pane,window}` | A terminal in `tab` (made on demand). An existing `id` is only focused. |
| `close` | `id` | Remove the terminal (a native pane's program is not touched). An emptied tab closes. |
| `focus` | `id`, `ifFocus` | Its tab, its group of panes, the keyboard. With `ifFocus`, only if the user has not moved since (see `focusSerial`). |
| `set` | `id`, `title`, `color`, `attention`, `node` | Change what its header shows and which tree entry is its own. |
| `order` | `tab`, `ids[]` | The order of a tab's panes. |
| `plan` | `id`, `tab`, `path`, `agent`, `text` | A plan agent pane `id` asked the user to read: Markdown in a panel over `tab` only; again for the same `id`: reloaded, scroll kept. |
| `plan-close` | `id` | Its plan panel goes. |
| `copy` | `text` | Onto the clipboard, said in the status bar. |
| `tab` | `tab`, `color`, `focus`, `close`, or `cycle: ±1` | A tab's colour (also the hue of its terminals), focus, close; or step through the tabs. |
| `tabs` | `order[]` | The order of the tabs. |
| `zoom` / `minimise` | `id`, `on` | One pane over the whole tab; a pane parked as a button under the grid. |
| `tree` | `nodes[]`, `select` | The sidebar: `{id, label, icon, state, badge, dot, dotColor, color, bold, dim, tooltip, actions[], children[]}`. `state` (an agent's: `work`, `ask`, `wait`, or empty) picks its icon's picture; `work` animates. |
| `sidebar` | `select` | Select an entry, or move the keyboard to the list (and back). |
| `menu` | `menus[]` | The menu bar: `{title, items[{id, label, shortcuts[], key} or {separator}]}`. `host.*` ids are done by the window, the rest come back as `action`. |
| `ask` | `id`, `title`, `text`, `schema`, `values`, `ok`, `cancel` | A form dialog from a JSON Schema; the reply is an `answer` event. |
| `settings` | `schema`, `values`, `open` | The Settings dialog's form. |
| `look` | `scrollback`, `scrollbackCapGB`, `seedLines`, `copyOnSelect`, `clipboardFromPrograms`, `scheme`, `tint`, `alternate`, `transparency`, `blur`, `perGroup` | How terminals look and behave (see below). |
| `font` | `family`, `size` | For all terminals. |
| `send` | `id`, `text` | Type text into the terminal. |
| `notify` / `busy` / `placeholder` | `text`, `level`, `alert` | Status bar message; the driver's "working on…" label; the text shown with no tab open. |
| `list` | | Reply `list`: terminals (with `native`, `live`, `onScreen`, `cols`, `rows`, `history`…), tabs, tree nodes, open dialogs, actions. |
| `grab` | `path`, `dialog` | A PNG of the window (or one dialog) as drawn. |
| `screen` | `id`, `from`, `to` | A terminal's rows as text, with its cursor; lines count from the top of the scrollback. |
| `consoles` | `tab`, `show`, `hide`, `pin` | A machine's consoles panel (`open` with `tab` `_consoles`, tagged like any tab, puts a terminal in it): up over the view in front, off it, pinned over every view. |
| `run` | `action` | Do a menu action as its menu item would (`host.*` here, the rest sent as `action`). |
| `raise` / `ping` / `quit` / `emit` | `event` | Show the window; reply `pong`; exit; send `event` to the clients as if the window had (a user action is kept for a driver that is starting). |
| `title` / `color` / `attention` | `id`, … | `set` by another name. |
| `scheme` | `name` | A named qtermwidget colour scheme for every terminal; empty: the window's own. |
| `toggle` | `show` | Drop-down style: up front and full screen, or hidden (`show` only shows). |
| `globalKey` | `keys` | The desktop-wide show/hide key (KDE), taken over live. Only a window for this machine holds it. |
| `connect` | `machine`, `driver[]`, `tmux[]` | Another machine's projects in this window: its driver started from `driver` (argv, stdio), its tmux reached through `tmux`. |
| `disconnect` | `machine` | Take them out again; they keep running there. |
| `fill` | `id`, `key`, `enum`, `enumLabels`, `note` | New choices for a picker of an open dialog (they were still loading): ticks stay, the search still applies; `note` shows under the list ("loading…"). |
| `answer` | `id`, `values` or `cancelled` | Answer an open dialog without clicking (tests). |

`look`: `seedLines` (default 50000) is how much of tmux's own scrollback a pane starts
with, never all of it: tmux builds a capture in memory. `scheme` empty means the window's own colours, where a tab's colour tints its
terminals' background by `tint` percent and, with `alternate`, neighbouring panes take
two shades of it. `transparency` (percent) makes the terminals' background see-through
(`blur` asks KWin to blur behind). `perGroup` is how many panes are on screen at once;
the rest are in further groups, one keystroke away.

With `MC_TERM_TEST` set there are also `keytable {row, keys, enabled, accept}` (a key pressed
into a row of the open Settings' Shortcuts table, a row ticked, the dialog accepted; reply
`keytable {rows, modal}`), `modal {button}` (a button of the open question),
`key {keys}` (a real key press), `resize {w,h}`,
`stale {id}` (does the terminal draw what it holds?) and `alpha {id}`.

## Events (window → clients), `ev`

Every event carries `focusSerial`: how many times the user has moved the keyboard or the tab in
front (moves a client asked for do not count). A client that starts something on an event and
finishes it later passes that number back as `ifFocus` on `focus`, `tab {focus}` or
`open {focus}`; the window then takes the keyboard only if the number is unchanged.

`hello {version}` · `opened {id, tab}` · `seeded {id, history, gap}` (a native pane's
state is in) · `exited {id, reason}` (its program or pane ended; the terminal is
removed) · `closed {id}` · `reattached {session}` · `fell-behind {id}` · `focused {id, tab}` · `tab {tab}` ·
`tab-close {tab}` (the user clicked a tab's ×: the driver decides) · `select {node}` /
`activate {node}` (click; Enter or double-click) · `action {action, node, id, tab}` ·
`answer {id, values | cancelled}` · `plan-ask {id, path, selection, question}` (Enter in a plan's ask box; `selection` the passage selected, lines joined by `\n`) · `plan-closed {id}` · `settings {values}` · `settings-open` ·
`minimised {id, on}` · `note {id, title, body}` (a program asked the terminal to
notify) · `scrollback-dropped {id, lines}` · `bell {id}` · `title {id, title}` ·
`list`, `screen`, `grabbed`, `pong` (replies) · `error {error}` · `quit`.
