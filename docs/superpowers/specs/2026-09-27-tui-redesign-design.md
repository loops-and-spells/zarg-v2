# The TUI redesign: rail, one focus, a grid of agents

Date: 2026-09-27
Status: design approved in conversation (four sections; mockup `packages/view-tui/mockups/redesign.tsx`, never committed), pending written review
Parents: `docs/superpowers/specs/2026-09-27-shell-sheet-design.md` (bar, sheet, popovers, surfaces, input layers), `docs/superpowers/specs/2026-09-27-input-layers-design.md`
Replaces: that spec's layout (agents list + tile area) and every renderer's look

## Outcome

The shell stops looking like boxes in boxes. A narrow rail of agents on the left, and one focus to its right: a paginated grid of agent cards (the resting view), one agent's view, zarg's conversation, or a review queue of every agent's findings. zarg stays one keystroke away (the bar, and its sheet over whatever has focus). Hierarchy comes from weight, dimming and one accent colour, not frames. Keys show once, on the status line. The developer moves between talking, watching and reviewing without a fixed home; attention signals and never steals focus.

Target look: opencode / Claude Code (borderless, conversation-first, one accent), lazygit / k9s (dense, keyboard-first, keys in one footer), btop / helix (a real theme, gauges, glyphs), Linear / Raycast (quiet chrome, a command palette). Terminal: truecolor, plain Unicode (no Nerd Font).

## 1. Visual language

- **Theme tokens** (`@zarg/view`, one built-in theme): `bg`, `raised` (rail, bar, sheet, popovers), `line` (faint rules and card borders), `text`, `dim`, `faint`, `accent` (blue: focus, zarg), `attention` (amber), `ok` (green), `error` (red), `selection` (the cursor row's background). Plugins keep their tones (`normal`, `ok`, `warn`, `error`, `dim`, `accent`); the shell maps tones to tokens (`warn` → `attention`). No raw colours from plugins.
- **Hierarchy without boxes:** a section is a bold title and a faint rule (`findings 3 ───────`). Borders only on grid cards (rounded, `line`; `accent` when selected), popovers and the palette. Never a box in a box.
- **Weight:** bold for names and titles, normal for content, `dim` for everything secondary (ids, times, counts, reasons, plugin context). The focused area's title is `accent`.
- **Cursor and selection:** the cursor row has the `selection` background and an `accent` `▍` in the gutter. A selectable table shows `○` (dim) on each row and `●` (accent, brighter text) on selected ones; a table that is not selectable shows no mark.
- **Glyphs:** `⠼` (braille spinner) running, `✓` done, `✗` failed, `■` stopped, `◆`/`◇` attention (pulsing until seen), `⚑` flagged, `━` gauges, `▸`/`▾` folds, `›` picker and input, `●○` page dots.
- **Keys once:** the status line lists the keys of what has focus; tables, titles and cards carry none (a card keeps its one action line). Once rows are selected, a selectable table (and the review queue) shows its selection actions as buttons under the list, each with its key; a click runs it.
- **Names:** plugin prefixes (`rehearse:`) and view keys (`@status`) never show. An agent shows its title with its plugin and task as dim context (`tester-1  rehearse · checkout`). Nothing wraps; overlong text ends in `…` (never cut in the middle).

## 2. Layout and navigation

```
 agents  ◆2        │ <focus: grid · agent · zarg · review>
 ◆ zarg      asks  │
 ⠼ rehearse 12/18  │
   ━━━━━━━━━━━     │
   ◆ tester-1  3   │
 ▸ archived 4      │
 ◆ zarg asks Split UX-0012?   ⏎ answer   / chat          ← the bar
 core · main · YOLO   ←→↑↓ move  ⏎ open  ^k jump          ← status + keys
```

- **Rail** (left, 24 columns, `raised`, full height): the agents tree flattened, children indented without tree lines; each row: glyph, title, a short note right-aligned (progress, "asks", count), a thin gauge under running agents; attention rows pulse; `▸ archived N` at its foot (archive behaviour unchanged). Under 100 columns it folds to glyphs (3 columns); `alt+a` unfolds it over the focus.
- **The focus**, one of:
  1. **Grid** (the resting view, and where the shell opens; zarg's sheet may cover it, below): agent cards, paginated. As many columns and rows as fit at about 44×10 per card (at least 1×2; 2×2 at 100 columns). Order: attention (unseen first), running, finished. `]`/`[` or `pgdn`/`pgup` page; page dots in the header. Arrows move between cards; `⏎` opens the agent's view; the card's action key (`a`) runs its declared action.
  2. **Agent:** one agent's view, borderless (headed blocks), plugin panels at its edges (as now); `[`/`]` move between sections, `{`/`}` between tabs.
  3. **zarg:** the conversation as the focus, from the palette (the sheet is not used then).
  4. **Review:** every plugin's review rows in one queue, grouped by agent (dim rule per agent), `○`/`●` selection, the table's actions (`a` apply, `d` dismiss) acting on that row's agent and section, `⏎` opens the agent.
- **Bar and sheet** as the shell spec: one line (zarg's question, the typing, zarg's latest reply); zarg's sheet rises over the focus from the bar, Esc closes it, the focus stays behind.
- **Arriving** (at launch, and on going home: `⇥` or Esc with nothing left to go back to): the grid, with zarg's sheet **open when nothing is going on** (no agent but zarg running or asking for the developer, archived ones aside) so new work starts in the conversation, and **closed when agents work** so their cards show. The shell never opens or closes the sheet on its own after that: work starting or ending leaves it as it is; `alt+m`, `/` or a click on the bar opens it, Esc closes it.
- **Moving:** `^k` the palette (type to find an agent, the grid, review, zarg, a slash command; ⏎ goes); `⇥` back to the previous focus (a back stack; Esc also goes back one step: agent → grid); `g` the next agent that needs you; `alt+a` the rail, `alt+m` the bar, `/` a command; Alt+arrows between rail, focus, its panels and the bar.
- **Popovers** (grants, plugin popovers): unchanged behaviour (one shared FIFO queue), restyled (`raised`, rounded, `attention` border for grants, `accent` for plugin popovers).
- **Attention signals, never steals:** ◆ pulses on the rail row and the card until seen, the status line names the first, `g` goes there. Focus moves only when the developer asks.

## 3. What plugins provide

- **`card` surface kind:** how an agent looks in the grid, mapped onto sections of its view (nothing extra to push):
  ```ts
  { kind: "card", name: "tester", view: "tester",
    headline: "progress",   // a stats section: its first item is the headline, its progress the gauge
    recent: "steps",        // optional: a log, list or table section; its last 3 lines or rows
    action: "apply" }       // optional: one action of that view, shown on the card and run with its key
  ```
  Every agent that started with that `view` shows as that card. An agent without one (zarg's driver, RLMs, plugins that declare no card) shows a minimal card from its row: glyph, title, progress or turns, row text (the agents tree's data; nothing guessed from the view).
- **Review:** a table section may carry `review: true`. The review queue lists the rows of every such table of every agent, with that table's actions, acting exactly as in the agent's own view. Rehearse marks its `findings` tables.
- **Checks** (SDK at build, host at load, as surfaces): a card's `view` is declared; `headline` names a stats section of that view; `recent` a log, list or table; `action` an action of that view; `review` only on tables.
- **Theme:** plugins use tones only (section 1).

## Errors

- An agent whose view is missing or empty: its card says `starting…`, its view `no view yet`.
- A card slot whose section has no data yet: the slot stays blank.
- 80×24: the rail folds to glyphs; the grid shows one column of short cards (headline and gauge; no recent lines).
- A palette query with no match: `nothing matches` in dim; Esc closes.

## Testing

- `@zarg/view`: tone → token mapping; `card` and `review` checks (unknown view, wrong section kinds, unknown action, `review` off a table); selection marks.
- SDK and host: cards and review flags travel in the manifest and are refused as above.
- TUI (`testRender` at 130×32, 100×30, 80×24): each focus (grid, agent, zarg, review) and the resting grid at start; grid paging and ordering (attention first); a card's action; review actions reach the right agent and section; the palette (filter, go, no match); `⇥`/Esc back stack; attention never moves focus; nothing wraps and names end in `…`; the rail folded under 100 columns.
- Rehearse: its tester and run cards and its findings marked for review.

## Scope

In: theme tokens and the tone mapping; the rail; the four focuses with the grid as the resting view; the palette; the back stack and key changes (`⇥` back, `[`/`]` sections, `{`/`}` tabs); every section renderer restyled; the `card` surface kind and `review: true`, checked at build and load; rehearse's cards and review; popovers restyled.

Out: user themes (one built-in theme), Nerd Font icons, resizing by mouse, reordering the grid by hand.
