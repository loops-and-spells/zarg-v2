# The shell: the agents list, the message bar, zarg's sheet and popovers

Date: 2026-09-27
Status: layout approved in conversation (mockup `packages/view-tui/mockups/sheet.tsx`, never committed), pending written review
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

- **One FIFO queue of popovers** in the shell. Only its head shows, centred over the whole screen (the agents list included), with `N of M · next: <title>` in its header.
- **Grants are popovers.** A question with `kind: "grant"` (plugin load grants, powers asked on demand, outside reads) never goes to zarg's bar or sheet: the client puts it in the queue. The core lets grant questions wait side by side with zarg's own question (a grant never blocks zarg's question, nor zarg's question a grant) and answers each by its id.
- **Keys:** ←→ or ↑↓ pick, Enter chooses, Esc sends the head to the back of the queue ("later"; it stays asked). Global keys still work over a popover.
- **A plugin view may be a popover** (below): it joins the same queue when the developer opens it.
- YOLO unchanged: YOLO never asks, so no grant popover appears under YOLO.

## Placement of a plugin's view

A view's layout declares `placement: "tile" | "popover"` (default `tile`).

- `tile`: opens in the tile area, as today.
- `popover`: opens in the popover queue when the developer opens the agent (Enter, `g`, a click); it never opens itself. Esc closes it (a plugin popover is not a question, so there is no "later").
- A platform may show a placement differently (a phone may show a popover as a full sheet); placement is a hint.

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

- `@zarg/view`: `placement` in the layout schema (default `tile`); input dispatch per layer in the table above; `g` and `/` are letters while the bar types; Alt+letters work while typing.
- Client: grant interrupts land in the popover queue in arrival order, never in zarg's conversation; answering one leaves the others; zarg's question and a grant pending together.
- Core: a grant question and zarg's question pending at the same time, each answered by id; outside reads and plugin grants no longer wait on zarg's question.
- TUI (`testRender` at 130×22 and 80×24): the layout (list full height, bar under the tile area only); the bar in each state; the sheet opening and closing on each trigger; the popover queue (head only, count, Esc to the back); attention blinking until opened, then steady; hotkey letters in titles; narrow strip and `alt+a`.
- Regressions carried over: arrows never reach two owners; a question arriving while another panel has focus takes no keys; the slash box takes ↑↓ only while open.

## Scope

In: the layout (agents list, tile area, message bar), zarg's sheet, the popover queue with grants in it, `placement: tile | popover`, the attention pulse, Alt+letter hotkeys, the input layers (from the input-layers spec, with the table above), agents' per-platform key mappings.

Out: `panel` placement and several tiles side by side in the tile area; archiving agents; a plugin agent's own message input (the bar is zarg's); web and native shells.
