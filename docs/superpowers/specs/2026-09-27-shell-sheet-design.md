# The shell: the agents list, the message bar, zarg's sheet and popovers

Date: 2026-09-27
Status: layout (mockup `packages/view-tui/mockups/sheet.tsx`, never committed) and surfaces (a plugin chooses agent or shell scope per panel) approved in conversation, pending written review
Parents: `docs/superpowers/specs/2026-09-27-agents-tiled-shell-design.md` (agents, attention), `docs/superpowers/specs/2026-09-27-input-layers-design.md` (the layer model and agents' key mappings)
Replaces: section 4 of the tiled-shell spec (zarg's conversation as an always-visible tile) and the layer table of the input-layers spec

## Outcome

The open agent's view gets the screen. zarg is one line at the bottom, the message bar, until the developer wants the conversation: then zarg's sheet covers the tile area. Grant questions stop interrupting zarg's conversation: they pop over everything, one at a time, first in first out. Agents that need the developer pulse in the agents list until the developer looks. Every key still has exactly one owner, through the input layers.

## Layout

```
┌ Agents ◆1 alt+a ───────┐┌ v rehearse r-3f2a alt+v ───────────┐
│ ● zarg        idle     ││ journeys  [findings]  testers      │
│ ◆ REHEARSE 4 findings  ││   ☐ UX-0012  checkout: no way back │
│   └ ✓ tester-1  done   ││   …                                │
│                        │└────────────────────────────────────┘
│                        │┌────────────────────────────────────┐
│ ↑↓ move · Enter open   ││ message zarg… (alt+m or /)         │
└────────────────────────┘└────────────────────────────────────┘
```

- **Agents list:** full height on the left, 30 columns.
- **Tile area:** everything to the right of the list, above the bar. It shows the open agent's view; with no agent open, zarg's sheet.
- **Message bar:** one line (three with its border) under the tile area only, never under the agents list.
- **Panels** dock to the tile area's edges (top, bottom above the bar, right): shell-scope ones (status bars) whatever is open, agent-scope ones with their agent (see Surfaces).
- **Narrow (under 100 columns):** the agents list folds to a one-line strip above the tile area (rows with their ◆, attention first, as today); `alt+a` unfolds it over the tile area until Enter or Esc.

## The message bar

The bar is zarg's one text input. It shows, in this order of precedence:

| state | the bar shows |
|---|---|
| zarg asks and the developer is not typing | `? <question>` and `alt+m or / to answer` |
| the developer types (a message, a free-text answer, chat about the question) | the input with a label: `message ›`, `answer ›`, `chat ›` |
| otherwise | `message zarg…`, or zarg's latest reply shortened when the sheet is closed and the reply is unread |

- **Focus:** `alt+m`, `/` (the bar opens with the `/` typed, so slash commands work from anywhere outside a text input), a click, or Alt+arrows to it.
- **Enter** sends (or answers). Sending a message opens the sheet so the reply is seen.
- **Esc** leaves the bar (chat or free text: back to the options first, as today).
- The slash box opens above the bar while the input starts with `/`, as today.

## zarg's sheet

zarg's conversation as a sheet over the whole tile area, down to the bar (the agents list stays visible beside it): messages, then zarg's question as the picker (the conversation section and behaviour from `@zarg/view`, unchanged).

- **Opens:** focusing the bar while zarg asks; `alt+m` while the bar already has focus; Enter on zarg's row in the agents list; sending a message; no agent open.
- **Stays open** while focus moves to the agents list (`alt+a`, a click), so the developer can browse while zarg talks.
- **Closes:** Esc on the sheet, `alt+v`, or opening another agent (Enter, `g`, a click on its row).
- The picker takes ↑↓ and Enter while the sheet is open and the bar is not typing; "Something else…" and "Chat about this" move the typing to the bar (its label changes), the sheet stays open above it.

## Popovers and the queue

- **One shared FIFO queue of popovers**, kept by the core: every popover (grants now, plugins' popover surfaces later) joins it in arrival order, and every client shows the same head. Strict first in, first out: nothing reorders it. Only its head shows, centred over the whole screen (the agents list included), with `N of M · next: <title>` in its header.
- **Grants are popovers.** A question with `kind: "grant"` (plugin load grants, powers asked on demand, outside reads) never goes to zarg's bar or sheet: the client puts it in the queue. The core lets grant questions wait side by side with zarg's own question (a grant never blocks zarg's question, nor zarg's question a grant) and answers each by its id.
- **Keys:** ←→ or ↑↓ pick, Enter chooses. A grant has no Esc: it stays until answered. Esc closes a plugin popover (that closes it on every client). Global keys still work over a popover.
- **A plugin's popover surface** (below) joins the same queue when opened.
- YOLO unchanged: YOLO never asks, so no grant popover appears under YOLO.

## Surfaces: where views are shown

A view is content (sections, actions, keys). A **surface** is where a view is shown. The pattern is Wayland's surface roles (a client opens any number of surfaces, each with a role and its own config; the compositor places them) with VS Code's declared contributions (the manifest lists them, so the host checks them at load) and Emacs' split between a buffer and the window showing it.

### Declared in the manifest, one typed config per kind

```ts
type Surface =
  | { kind: "tile";    name: string; view: string }
  | { kind: "panel";   name: string; view: string; scope: "agent" | "shell"; edge: "top" | "bottom" | "right"; size: number | `${number}%`; input: "none" | "onFocus" }
  | { kind: "popover"; name: string; view: string }
  | { kind: "sheet";   name: string; view: string }
```

- `tile`: the tile area's main content while its agent is open.
- `panel`: docked to an edge of the tile area. `scope: "agent"`: shown only while its agent is open. `scope: "shell"`: shown whatever is open (a status bar, `size: 1`). `input: "none"`: never takes focus (a pure status bar); `onFocus`: takes keys while focused.
- `popover`: joins the shared popover queue (the core's, first in first out); owns the keyboard while it is the head; Esc or its own actions close it.
- `sheet`: covers the tile area down to the bottom panels; owns the tile area's keys while open. One sheet open at a time.
- The SDK's `defineSurface` and the host at load refuse: a surface naming a view the plugin does not declare, a duplicate surface name, a config that does not fit its kind.

### Opened at run time, as many as wanted

- A surface **instance** is `(plugin, surface, instance key)`. A plugin may open the same surface several times under different keys (a findings panel per tester). Each instance has its own view data: `Views` pushes take the instance key.
- SDK: `Surfaces.open(surface, { instance?, focus? })` returns a handle with `close`; `Surfaces.close(surface, instance?)`. Several surfaces open together in one call: `Surfaces.open([...])`, so "open the tile and its panel" is one change the shell shows at once.
- **Actions open surfaces declaratively too:** an action may carry `opens: [{ surface, instance?, agent? }]`. The shell opens them at once, without a round trip to the plugin, then runs the action (if it has a handler). A status bar's "open" action is `opens: [{ surface: "main" }]` with no handler. `agent` may name another of the plugin's agents (a tester's view from the run's status bar); never another plugin's.
- **Who may open what, when:**
  - panels (either scope): any time;
  - tiles, sheets and popovers: only in response to the developer, meaning a declared `opens`, or a `Surfaces.open` made while the plugin handles an `act`, `answer` or `message` call (the host carries the call's gesture and refuses an open outside one). Otherwise the plugin asks for attention and the developer opens it.
- **The shell has the last word.** It lays surfaces out, may downgrade them on a small screen (panels stacked, a popover as a sheet) and caps shell-scope panels: at most one per plugin, at most two per edge; extras wait in the order they opened, and the developer can close any panel (it stays closed until the plugin opens it again).
- The developer opening an agent (Enter, `g`, a click) opens its `tile` (or, lacking one, its first `sheet`, then its first `popover`) with its agent-scope panels.

### zarg uses the same surfaces

- zarg's conversation is agent-zarg's `sheet` (`conversation`) and the message bar is its shell-scope `bottom` panel (`size: 1`, `input: "onFocus"`) showing the same conversation section in its compact form (the question or the input on one line). The conversation renderer gains that compact form.
- Grant popovers are the core's own popover surface, not a plugin's.
- The shell itself draws only the agents list and the popover queue; everything else is a surface.

## Attention

- The plugin owns what attention says: `Attention.request(agent, reason)` as today, the reason shown in place of progress.
- The shell owns how it looks, the same for every plugin: while the developer has not opened the agent since the request, its ◆ blinks (◆ / ◇, every 500 ms) and its name alternates bright and dim; the list's title counts them (`Agents ◆N`). Once opened, the ◆ stays steady in the attention colour until the plugin clears it.
- `g`, Enter on the row or a click opens the agent. `g` picks the next agent with attention (unseen ones first, then tree order, zarg first).
- The animation is one shell-wide timer that runs only while something blinks.

## Hotkeys

- **Alt+letter focuses a panel**, and the letter is coloured and underlined in the panel's name: `alt+a` Agents, `alt+v` the open view, `alt+m` message. A letter not in the name is shown before it (`v rehearse r-3f2a`).
- Alt+arrows still move between the agents list, the tile area and the bar.
- All Alt keys are global (plugins can never map them, as the input-layers spec says).

## Input layers (replacing the input-layers spec's table)

The model and dispatch are the input-layers spec's: layers derived from state, the key goes to the top layer, each handles or passes. Top first:

| layer | on the stack when | keys it owns |
|---|---|---|
| global | always | Ctrl-C, Ctrl-D, Alt+←→↑↓, `alt+a` `alt+v` `alt+m` |
| popover | the queue is not empty | ←→ ↑↓ Enter Esc, its own keys; passes nothing else but global |
| slash box | the bar has focus and its input starts with `/` | ↑↓ Tab Enter Esc |
| bar (text) | the bar has focus and is typing | printable keys, Backspace, Enter, Esc |
| panel | a panel with `input: "onFocus"` has focus | its view's keys (as the view layer), `g`, `/` |
| sheet | the sheet is open and the tile area has focus | ↑↓ Enter (picker), PgUp PgDn (scroll), Esc (close), `g`, `/` |
| view | an agent view is open in the tile area and has focus | as in the input-layers spec (Tab, ↑↓, PgUp PgDn, `[` `]`, Space, Esc, the agent's own keys), `g`, `/` |
| agents | the agents list has focus | ↑↓ ←→ Enter, `g`, `/` |

- `g` and `/` belong to the non-text layers, so typing them in the bar is typing.
- Terminal reserved keys (plugins may not map them): the input-layers list plus `/`.
- Status hints come from the top layers, as in the input-layers spec; the agents list shows its own in its footer.

Everything else in the input-layers spec stands: agents own their key mappings per platform (`keys: { terminal, web }`, `key` as shorthand), view-level actions, reserved and duplicate keys refused by the SDK at build and by the host at load.

## Errors

- zarg not loaded: the bar says `zarg is not loaded: <reason>` and does not take focus; the sheet shows the agenda item that explains.
- A grant answered by another client (a second TUI on the same core) leaves the queue when its interrupt resolves; a grant withdrawn by the core (closeStale, the plugin gone) leaves the queue too.
- A popover view whose plugin stops: removed from the queue.

## Testing

- `@zarg/view`: the `Surface` schema (each kind's config refused when it does not fit); the compact conversation form; input dispatch per layer in the table above; `g` and `/` are letters while the bar types; Alt+letters work while typing.
- Client: grant interrupts land in the popover queue in arrival order, never in zarg's conversation; answering one leaves the others; zarg's question and a grant pending together.
- SDK and host: surfaces naming unknown views or duplicated names refused at build and load; `Surfaces.open` of a tile, sheet or popover refused outside a developer call, allowed inside `act`, `answer`, `message`; panels open any time; duplicate instances with their own data; `opens` on an action opens surfaces before the handler runs, and never another plugin's agent.
- Core: a grant question and zarg's question pending at the same time, each answered by id; outside reads and plugin grants no longer wait on zarg's question.
- TUI (`testRender` at 130×22 and 80×24): the layout (list full height, bar under the tile area only); the bar in each state; the sheet opening and closing on each trigger; the popover queue (head only, count, strict arrival order); shell-scope status bars shown with any agent open, agent-scope panels only with theirs, the per-edge cap; a status bar action opening an agent's tile and panel together; attention blinking until opened, then steady; hotkey letters in titles; narrow strip and `alt+a`.
- Regressions carried over: arrows never reach two owners; a question arriving while another panel has focus takes no keys; the slash box takes ↑↓ only while open.

## Scope

In: the layout (agents list, tile area, message bar), surfaces (`tile`, `panel` with agent and shell scope, `popover`, `sheet`) declared per plugin and opened as many times as wanted, declaratively from actions or from a developer call, zarg's sheet and bar as agent-zarg's surfaces, the popover queue with grants in it, the attention pulse, Alt+letter hotkeys, the input layers (from the input-layers spec, with the table above), agents' per-platform key mappings.

Out: several tiles side by side in the tile area (panels cover the need for now); floating panels; archiving agents; a plugin agent's own message input (the bar is zarg's); web and native shells.
