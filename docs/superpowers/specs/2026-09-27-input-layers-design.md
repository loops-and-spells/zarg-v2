# Input layers: one owner for every key

Date: 2026-09-27
Status: approved; its layer table is replaced by `2026-09-27-shell-sheet-design.md`, the rest stands
Parents: `docs/superpowers/specs/2026-09-27-agents-tiled-shell-design.md` (tiles), `docs/superpowers/specs/2026-09-27-agent-views-design.md` (views, platforms)
Research: opencode's TUI (anomalyco/opencode, packages/tui) routes keys through priority layers gated by a mode stack; focus follows state; scrollboxes are never focused.

## Outcome

Every key has exactly one owner, and "what does ↑ do right now" has one answer. The shell's input is a stack of layers computed from state. A key goes to the top layer; that layer handles it or passes it down, explicitly. The model and its dispatch are platform-free in `@zarg/view`, tested without a renderer, and reused by a web or native shell later. The terminal shell only renders: which input has focus, what the scrollboxes show; it never routes keys itself.

## The model (`@zarg/view`, `input.ts`)

- **Layers are derived, not pushed.** `layersOf(ui, world)` returns the stack from state each time (the focused tile, whether zarg has a question, whether the developer is typing an answer or chatting, whether the slash box is open, whether a dialog is open). Nothing can leak: close the thing and its layer is gone. (opencode pushes and pops; derivation gives the same guarantee without the discipline.)
- **Dispatch:** `dispatch(ui, world, key) → { ui, action? }` walks the stack from the top. Each layer answers `handled` (with a new `ui` and maybe an action), or `pass`. A key no layer handles does nothing.
- **Global layer on top, with a closed list:** Ctrl-C (stop; twice within 2 s exits), Ctrl-D (exit), Alt+arrows (move between tiles). Nothing else is global.
- **Text layers own printable keys.** While a text input is on top (the message input, the free-text answer, chat), letters, space and Backspace are its own; the renderer's input receives them, and no other layer sees them. `g` and actions keys are therefore safe while typing.
- **The world** is the read-only state layers read: the session state (thread, question, views, rows) and the tile layout (wide or narrow, which tiles exist).

## Layers and their keys

Top to bottom as they can stack. A key not listed passes down.

| layer | on the stack when | keys it owns |
|---|---|---|
| global | always, on top | Ctrl-C, Ctrl-D, Alt+←→↑↓ |
| dialog | a dialog is open (grant details, archive confirm; later) | ↑↓ Enter Esc, its own keys; passes nothing |
| slash box | the message input starts with `/` | ↑↓ (rows), Tab (complete), Enter (run), Esc (close) |
| text: message / chat / free text | that input is shown and zarg's tile has focus (for free text: its row is highlighted) | printable keys, Backspace, Enter (send or answer), Esc (chat: back to the options; free text: back to the options) |
| question picker | zarg's tile has focus and zarg asks | ↑↓ (options), Enter (answer, or start chatting / typing) |
| zarg tile | zarg's tile has focus | PgUp PgDn (scroll the messages), `g` |
| view tile | the view tile has focus | Tab / Shift-Tab (sections), ↑↓ PgUp PgDn (rows or scroll), `[` `]` (tabs), Space (select), Esc (close the view), `g`, and the open agent's own key mappings for this platform |
| agents tile | the agents tile has focus | ↑↓ (move), ←→ (fold), Enter (open), `x` (archive, later), `g` |

`g` belongs to the three tile layers, not to the global layer: a text layer above them takes it as a letter.

## Agents own their key mappings

- **An action is platform-free; its keys are the plugin's, per platform.** An agent declares actions in its view (table actions as today, and view-level actions not tied to a table, such as "rerun"). Each action may carry key mappings for the platforms that have keys:
  ```ts
  { id: "apply", label: "Apply", on: "selection", keys: { terminal: "a", web: "mod+enter" } }
  ```
  A platform applies the mapping for itself when there is one; a platform without keys (touch) or without a mapping shows the action as a button or menu item. The current `key: "a"` stays as shorthand for `keys: { terminal: "a" }`.
- **Declared, never registered at runtime.** Mappings live in the view's layout (the manifest), so the key tables and the hints always list them.
- **Scoped to the agent's own layer.** The view tile's layer takes its keys from the open agent's actions: an agent's keys act only while its view has focus, never in zarg's tile, the agents tree or another agent's view.
- **Each platform keeps its own reserved keys.** A plugin cannot map a key a platform's own layers own. For the terminal: Ctrl-*, Alt-*, arrows, Tab, Shift-Tab, Enter, Esc, Space, PgUp, PgDn, `[`, `]`, `g`, `x`. The SDK refuses such a mapping at build time and the host at load (as it refuses bad slash commands); two actions with the same key in one view are refused too. A platform ignores a mapping it cannot parse.
- **Slash commands stay zarg's:** they are said to zarg, so they live in the message input's slash layer.

## The terminal renderer

- Focus follows the model: the one text input whose layer is on top gets `focused`, every other input is blurred; scrollboxes are never focusable; the renderer runs with `autoFocus: false`.
- The keyboard hook calls `dispatch` once per key and applies the action; the input components' own key handling is limited to text editing (their layer owns those keys).
- A click sets the focused tile (or a row), through the same `ui` update.
- The status line's hints come from the top layer's key list (one source of truth).

## Testing

- `@zarg/view`: `layersOf` for each situation (question pending or not, chatting, free text, slash open, each tile focused, a dialog open); `dispatch` table tests: every key in the table above reaches its owner and no other; a key with no owner does nothing; `g` while typing is a letter; Alt+arrows while typing move tiles.
- Portability: `input.ts` imports nothing platform-specific (the existing test).
- SDK and host: an action mapping a reserved terminal key is refused at build and at load; a duplicate key in one view is refused; `key` still works as the terminal mapping; a mapping for another platform is kept and ignored by the terminal.
- TUI: frames for the regressions this replaces (arrows never scroll zarg's messages while the agents tile has focus; a question arriving while the view has focus takes no keys; the slash box takes ↑↓ only while open).

## Scope

In: the layer model and dispatch in `@zarg/view`; the TUI's key handling replaced by it; hints from the top layer; per-platform key mappings on agents' actions (with view-level actions), reserved keys refused at build and load.

Out: remappable keys, leader keys, which-key popups; the archive feature (its `x` is listed so the table has room for it).
