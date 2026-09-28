# TUI Redesign, Plan 2: The Focuses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The shell rests on a paginated grid of agent cards (zarg's sheet open over it on arrival when nothing is going on), and moves between the grid, one agent, zarg's conversation and a review queue with a palette and a back stack; plugins declare their cards and review tables.

**Architecture:** `@zarg/view` gains the `card` surface kind and `review: true` on tables, checked like surfaces; the core attaches an agent's card to its view's layout when the agent starts, so the client reads cards and review tables from the views it already holds. `@zarg/view-tui` gets a `main` focus (`grid | agent | zarg | review`) with a back stack, three pure modules (`grid.ts`, `review.ts`, `palette.ts`) and their input layers, and draws them.

**Tech Stack:** Bun (`mise x -- bun`), TypeScript, Effect 4 Schema, React 19, opentui 0.5.12.

**Spec:** `docs/superpowers/specs/2026-09-27-tui-redesign-design.md` (section 2's focuses, arrival, moving; section 3). Plan 1 (`docs/superpowers/plans/2026-09-27-tui-look.md`) built the look.

## Global Constraints

- `mise run verify` before every commit; `mise run build:plugins` after changing a first-party plugin or the SDK.
- `@zarg/view` imports only `effect`; view-tui and client never import `@zarg/core` or `/server`.
- The grid is the resting view. On arrival (launch, and going home: `⇥` or Esc with nothing left to go back to), zarg's sheet is open when nothing is going on and closed when agents work; the shell never opens or closes it on its own after that.
- "Agents work" = a plugin agent (id with `:`), not archived or deleted, running or asking for attention. zarg and its RLMs never count.
- Grid card about 44×10; at least 1 column × 2 rows; order: attention (unseen first), running, finished. `]`/`[` or `pgdn`/`pgup` page; page dots `●○`.
- Keys: `^k` palette, `⇥` back, Esc back one step, `g` next asking, `[`/`]` sections, `{`/`}` tabs in an agent view.
- Cards: `{ kind: "card", name, view, headline, recent?, action? }`; `headline` a stats section, `recent` a log, list or table, `action` an action of the view. `review: true` only on tables.
- A card slot with no data stays blank; an agent without a card shows a minimal card from its row; an agent without a view says `starting…`.
- Palette with no match: `nothing matches` in dim.
- Never start a core or the TUI in the repo root; no live models.

## Review Focus

1. Going back with an empty back stack from the agent view: lands home (the grid), never on nothing. → Task 2, test "Esc with nothing to go back to goes home".
2. The grid's cursor on a card whose agent is archived meanwhile: the cursor stays in range and on a card that exists. → Task 3, test "the cursor survives a card leaving".
3. A review action on selected rows spread over two agents: each agent gets only its own rows, in one call each. → Task 4, test "selected rows of two agents make one act per agent".
4. Typing in the palette `g`, `/`, `x`, `a`: all go to the query, none acts. → Task 5, test "the palette owns printable keys".
5. Arrival with only zarg's driver RLM running: counts as nothing going on — the sheet is open. → Task 2, test "zarg's own RLMs are not agent work".

---

### Task 1: The card and review contract

**Files:** Modify `packages/view/src/schema.ts` (`Surface` gains `card`; `leafFields.review`; `LayoutSchema.card`), `packages/view/src/surfaces.ts` (`surfacesProblem(surfaces, layouts)`), `packages/view/src/layout.ts` (`review` on table specs; refuse off tables), `packages/plugin-sdk/src/define.ts`, `packages/plugin/src/server/host.ts` (pass layouts), `packages/core/src/plugin-agents.ts` (attach the card on `start`); tests `packages/view/test/surfaces.test.ts`, `packages/view/test/layout.test.ts`, `packages/core/test/plugin-agents.test.ts`.

**Interfaces — Produces:**
```ts
// Surface union gains
Schema.Struct({ kind: Schema.Literal("card"), name: Schema.String, view: Schema.String, headline: Schema.String, recent: Schema.optionalKey(Schema.String), action: Schema.optionalKey(Schema.String) })
// A card as a view's layout carries it (the core puts it there when the agent starts)
export const CardSpec = Schema.Struct({ headline: Schema.String, recent: Schema.optionalKey(Schema.String), action: Schema.optionalKey(Schema.String) })
// LayoutSchema gains `card: Schema.optionalKey(CardSpec)`; leafFields gain `review: Schema.optionalKey(Schema.Boolean)`
// surfaces.ts — the second argument becomes the plugin's layouts (callers pass `views.map(layoutOf)` / manifest views)
export const surfacesProblem: (surfaces: unknown, layouts: ReadonlyArray<Layout>) => string | undefined
```
Card checks inside `surfacesProblem`: the view exists (as today); `headline` is a `stats` leaf of it (`leafAt`); `recent`, when given, a `log`, `list` or `table` leaf; `action`, when given, an action id of one of its leaves or its own actions. `defineView` throws `view <name>: <path> marks review but is a <kind>, not a table` for `review: true` off a table; the host refuses the same through a `reviewProblem(layout)` exported from `layout.ts` and called in `manifestProblem` after `keysProblem`.

Core (`plugin-agents.ts` `start`): `const card = cardOf(plugin, e.view)` where `cardOf` finds the plugin's `card` surface whose `view` is `e.view` (through the existing `surfaceOf` lookup extended to list a plugin's surfaces: add `cardsOf: (plugin) => ReadonlyArray<Surface>` next to `surfaceOf`), then `views.start(id, card === undefined ? layout : { ...layout, card: { headline: card.headline, ...(card.recent ? { recent: card.recent } : {}), ...(card.action ? { action: card.action } : {}) } })`.

- [ ] **Step 1: Tests.**
```ts
// view/test/surfaces.test.ts
const tester = layoutOf(defineView("tester", { progress: { kind: "stats", role: "summary" }, steps: { kind: "log", role: "log" }, findings: { kind: "table", role: "primary", columns: [], actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] } }))
test("a card names a stats headline, a log/list/table recent and an action of its view", () => {
  const card = { kind: "card", name: "tester", view: "tester", headline: "progress", recent: "steps", action: "apply" }
  expect(surfacesProblem([card], [tester])).toBeUndefined()
  expect(surfacesProblem([{ ...card, headline: "steps" }], [tester])).toMatch(/headline steps is a log, not stats/)
  expect(surfacesProblem([{ ...card, recent: "progress" }], [tester])).toMatch(/recent progress is a stats/)
  expect(surfacesProblem([{ ...card, action: "nope" }], [tester])).toMatch(/action nope/)
  expect(surfacesProblem([{ ...card, view: "gone" }], [tester])).toMatch(/view gone/)
})
// view/test/layout.test.ts
test("review marks tables only", () => {
  expect(() => defineView("v", { s: { kind: "log", role: "log", review: true } as never })).toThrow(/marks review but is a log/)
  expect(layoutOf(defineView("v", { t: { kind: "table", role: "primary", columns: [], review: true } })).sections[0]).toMatchObject({ review: true })
})
// core/test/plugin-agents.test.ts
test("an agent that starts with a view the plugin has a card for carries the card in its layout", async () => { /* surfaceSetup with a card surface for view "tester" (headline "progress"); start t1 with view tester; threadViews(log,"main").layout("rehearse:t1")?.card equals { headline: "progress" } */ })
```
Write the elided core test in full with the file's `surfaceSetup` helper (extended to take the card surface and to answer `cardsOf`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** as above; `layoutOf` carries `review` on leaves.
- [ ] **Step 4: Run** — `mise run build:plugins && mise run verify` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: plugins declare cards and review tables`.

---

### Task 2: The main focus, the back stack, arrival

**Files:** Modify `packages/view-tui/src/view.ts`, `packages/view-tui/src/layers.ts`, `packages/view-tui/src/view-keys.ts`; tests `packages/view-tui/test/view.test.ts`, `packages/view-tui/test/layers.test.ts` (and every existing test by the table below).

**Interfaces — Produces** (`view.ts`):
```ts
export type Main = "grid" | "agent" | "zarg" | "review"
// Ui gains
readonly main: Main                                              // what the focus area shows ("agent" uses `viewing`)
readonly back: ReadonlyArray<{ readonly main: Main; readonly viewing?: string }> // the back stack
readonly arrived: boolean                                        // the arrival rule ran
/** Plugin agents (id with ":") running or asking, not archived or deleted: work the grid shows. */
export const agentsWork: (s: SessionState) => boolean
/** Go to a focus, remembering where you were. */
export const goTo: (ui: Ui, main: Main, viewing?: string) => Ui
/** Back one step; with nothing to go back to, home (the grid, the arrival rule applied). */
export const goBack: (ui: Ui, s: SessionState) => Ui
export const goHome: (ui: Ui, s: SessionState) => Ui          // grid, sheet = !agentsWork(s), focus "tile", back []
```
- `sheetShown(ui)` becomes `ui.sheet || ui.main === "zarg"` (zarg's focus shows the conversation full; the grid never implies the sheet).
- `initialUi`: `main: "grid"`, `back: []`, `arrived: false`, `sheet: false`, `focus: "bar"`. `syncUi`: while `!arrived`, apply `goHome` once and set `arrived: true`; when the sheet opens on arrival focus stays `bar`, else focus `tile`.
- `openAgent(ui, s, id)`: zarg → `{ ...goTo(ui, "zarg"), focus: "tile" }` with `sheet: false`; others → `goTo(ui, "agent", id)` (sets `viewing`, clears `view`), `sheet: false`, focus `tile`.
- Layers: the `view` layer's `when` becomes `focus === "tile" && main === "agent" && !ui.sheet`; its Esc → `goBack`. The `sheet` layer's `when`: `focus === "tile" && sheetShown(ui)`; its Esc: when `main === "zarg"` → `goBack`, else closes the sheet (as now). A new common rule in `common()`: `tab` (⇥) → `goBack` (the text and slash layers keep their own Tab).
- `view-keys.ts`: `]`/`[` move between sections (`focusNext`), `}`/`{` switch tabs (`nextTab`); Tab no longer moves sections.
- The `grid` and `review` focuses get their layers in Tasks 3 and 4; until then their `when` is false and keys fall to `bar-idle`/`agents`.

| old | new |
|---|---|
| no agent open ⇒ zarg's sheet shows | the grid shows; the sheet only when `ui.sheet` (arrival opens it when nothing works) |
| Esc in a view: close it (sheet shows) | Esc: back (to the grid when opened from it) |
| Tab / Shift-Tab in a view: sections | `]`/`[`: sections; `}`/`{`: tabs; Tab: back |
| `ui.viewing !== undefined` ⇒ agent shown | `ui.main === "agent"` |

- [ ] **Step 1: Tests** (`view.test.ts`, `describe("focus")`):
```ts
const plugin = (id: string, status: "running" | "done", extra = {}) => ({ id, parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status, decisions: [], ...extra })
const st = (rlms: Record<string, RlmNode>, extra: Partial<ThreadState> = {}): SessionState => ({ thread: { ...initial("main"), rlms, ...extra }, core: "up" })
test("arrival: the grid, with zarg's sheet open when nothing is going on", () => {
  expect(syncUi(initialUi, st({}))).toMatchObject({ main: "grid", sheet: true, arrived: true })
  expect(syncUi(initialUi, st({ "p:t1": plugin("p:t1", "running") }))).toMatchObject({ main: "grid", sheet: false, focus: "tile" })
})
test("zarg's own RLMs are not agent work", () => {
  expect(agentsWork(st({ "rlm-1": plugin("rlm-1", "running") }))).toBe(false)
  expect(agentsWork(st({ "p:t1": plugin("p:t1", "done", { attention: { reason: "r", since: 1 } }) }))).toBe(true)
  expect(agentsWork(st({ "p:t1": plugin("p:t1", "running") }, { archived: { "p:t1": { reason: "x", at: 0 } } }))).toBe(true) // running never hides
  expect(agentsWork(st({ "p:t1": plugin("p:t1", "done") }))).toBe(false)
})
test("the shell never opens or closes the sheet on its own after arrival", () => {
  const ui = syncUi(initialUi, st({}))
  expect(syncUi(ui, st({ "p:t1": plugin("p:t1", "running") })).sheet).toBe(true)
})
test("Esc with nothing to go back to goes home", () => {
  const s = st({ "p:t1": plugin("p:t1", "running") })
  const opened = openAgent(syncUi(initialUi, s), s, "p:t1")
  expect(opened).toMatchObject({ main: "agent", viewing: "p:t1", back: [{ main: "grid" }] })
  const back = goBack(opened, s)
  expect(back).toMatchObject({ main: "grid", back: [] })
  expect(goBack(back, s)).toMatchObject({ main: "grid", sheet: false, back: [] })
})
```
`layers.test.ts`: in an agent view `]` moves to the next section, `}` to the next tab, Tab goes back to the grid, Esc goes back; in zarg's focus Esc goes back.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** as above; migrate existing tests by the table (ledger each rewritten expectation's reason).
- [ ] **Step 4: Run** — `mise run verify` — Expected: PASS (the app draws the grid area empty until Task 6; frame tests that land on it assert the rail and bar, not the tile area).
- [ ] **Step 5: Commit** — `feat(tui): a main focus with a back stack; the grid is home and the sheet opens on arrival when nothing works`.

---

### Task 3: The grid

**Files:** Create `packages/view-tui/src/grid.ts`; modify `view.ts` (`Ui.grid`), `layers.ts` (a `grid` layer); test `packages/view-tui/test/grid.test.ts`.

**Interfaces — Produces:**
```ts
export interface Card {
  readonly id: string                 // the agent id
  readonly glyph: string; readonly glyphToken: ThemeToken
  readonly name: string; readonly context: string   // displayName, contextOf
  readonly headline?: string          // the card's stats first item (value label), or the row text
  readonly gauge?: { readonly done: number; readonly total: number }
  readonly recent: ReadonlyArray<{ readonly text: string; readonly tone?: string }> // up to 3
  readonly action?: { readonly id: string; readonly label: string; readonly key: string; readonly section?: string }
  readonly starting: boolean          // no view yet
  readonly attention: boolean
}
/** Every live agent but zarg and RLMs, as cards, attention (unseen first), then running, then finished. */
export const gridCards: (ui: Ui, s: SessionState) => ReadonlyArray<Card>
/** How many cards fit: columns and rows in the focus area (about 44×10 a card, at least 1×2). */
export const gridShape: (width: number, height: number) => { readonly cols: number; readonly rows: number }
// Ui gains
readonly grid: { readonly cursor: number; readonly page: number }
```
Card content: a view whose `layout.card` exists → `headline` from its stats leaf's first item (`${value} ${label}`) and `progress` as the gauge; `recent` from the last 3 lines (log), items (list, `text`) or rows (table, cells joined by two spaces); `action` from the leaf that holds the action id (its key via `keyFor(a, "terminal")`, its section path). No `layout.card` → the minimal card: `headline` = `row.text` or `turns/budget`, `gauge` = `row.progress`. No view at all → `starting: true`.

Grid layer (`when: focus === "tile" && main === "grid" && !ui.sheet`): ←→↑↓ move the cursor within the page (by `gridShape` columns), `]`/`pagedown` next page, `[`/`pageup` previous, ⏎ `openAgent(card.id)`, the card action's key → `{ type: "act", section, action, rows: [], agent: card.id }` for `on: "none"` actions, else the rows the table's own `actionFor` would pick with an empty selection (the cursor row 0); `g`, `/`, Tab as common. The cursor is clamped to the cards that exist on every sync.

- [ ] **Step 1: Tests** (`grid.test.ts`):
```ts
test("cards: attention first (unseen first), then running, then finished; zarg and RLMs are not cards", () => {
  const s = st({ zarg: z, "rlm-1": rlm, "p:done": plugin("p:done", "done"), "p:run": plugin("p:run", "running"), "p:ask": plugin("p:ask", "done", { attention: { reason: "3 findings", since: 5 } }) })
  expect(gridCards(initialUi, s).map((c) => c.id)).toEqual(["p:ask", "p:run", "p:done"])
})
test("a declared card: its headline, gauge, last 3 recent lines and action", () => {
  const view = { agent: "p:t1", layout: { name: "tester", card: { headline: "progress", recent: "steps", action: "apply" }, sections: [
    { id: "progress", kind: "stats", role: "summary" },
    { id: "steps", kind: "log", role: "log" },
    { id: "findings", kind: "table", role: "primary", columns: [], actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] } ] },
    data: { progress: { items: [{ label: "steps", value: "12/18" }], progress: { done: 12, total: 18 } }, steps: { lines: ["a", "b", "c", "d"].map((text) => ({ text })) } } }
  const [c] = gridCards(initialUi, st({ "p:t1": plugin("p:t1", "running") }, { views: { "p:t1": view as never } }))
  expect(c).toMatchObject({ headline: "12/18 steps", gauge: { done: 12, total: 18 }, recent: [{ text: "b" }, { text: "c" }, { text: "d" }], action: { id: "apply", key: "a", section: "findings" } })
})
test("no card: the minimal card from the row; no view: starting", () => {
  const [c] = gridCards(initialUi, st({ "p:t1": plugin("p:t1", "running", { row: { text: "walking", progress: { done: 2, total: 9 } } }) }))
  expect(c).toMatchObject({ headline: "walking", gauge: { done: 2, total: 9 }, recent: [], starting: true })
})
test("the grid's shape: about 44×10 a card, at least 1×2", () => {
  expect(gridShape(100, 30)).toEqual({ cols: 2, rows: 2 })
  expect(gridShape(56, 20)).toEqual({ cols: 1, rows: 2 })
  expect(gridShape(180, 40)).toEqual({ cols: 4, rows: 4 })
})
test("the cursor survives a card leaving", () => {
  const two = st({ "p:a": plugin("p:a", "running"), "p:b": plugin("p:b", "running") })
  const ui = { ...syncUi(initialUi, two), grid: { cursor: 1, page: 0 } }
  expect(syncUi(ui, st({ "p:a": plugin("p:a", "running") })).grid.cursor).toBe(0)
})
```
(`st`, `plugin` as in Task 2's tests; `z` zarg's row, `rlm` an RLM row.) Layer tests: → moves the cursor, `]` pages, ⏎ opens the card's agent (`main: "agent"`), `a` acts with the card's agent.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (`gridShape`: `cols = max(1, floor(width / 44))`, `rows = max(2, floor(height / 10))`).
- [ ] **Step 4: Run** — `mise run verify` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(tui): the grid of agent cards`.

---

### Task 4: The review queue

**Files:** Create `packages/view-tui/src/review.ts`; modify `view.ts` (`Ui.review`), `layers.ts` (a `review` layer); test `packages/view-tui/test/review.test.ts`.

**Interfaces — Produces:**
```ts
export interface ReviewRow { readonly key: string; readonly agent: string; readonly section: string; readonly row: { readonly id: string; readonly cells: Readonly<Record<string, string>>; readonly tone?: string } }
export interface ReviewGroup { readonly agent: string; readonly name: string; readonly rows: ReadonlyArray<ReviewRow>; readonly columns: ReadonlyArray<{ readonly id: string; readonly label: string }>; readonly actions: ReadonlyArray<{ readonly id: string; readonly label: string; readonly key?: string; readonly keys?: Readonly<Record<string, string>>; readonly on: "selection" | "row" | "none" }> }
/** Every table marked `review` in every live agent's view, grouped by agent (rail order). Row keys are `${agent}|${section}|${rowId}`. */
export const reviewGroups: (s: SessionState) => ReadonlyArray<ReviewGroup>
/** An action over the selection (or the cursor row): one act per agent and section, with that agent's rows only. */
export const reviewActs: (groups: ReadonlyArray<ReviewGroup>, cursor: number, selected: ReadonlyArray<string>, key: string) => ReadonlyArray<{ readonly agent: string; readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string> }>
// Ui gains
readonly review: { readonly cursor: number; readonly selected: ReadonlyArray<string> }
```
Review layer (`when: focus === "tile" && main === "review" && !ui.sheet`): ↑↓ move over the flattened rows, ␣ toggles the cursor row's key in `selected`, ⏎ `openAgent(row.agent)`, an action key → `{ type: "review-acts", acts }` (a new `Action` the app runs as one `session.act` per entry) and clears `selected`; `g`, `/`, Tab as common.

- [ ] **Step 1: Tests** (`review.test.ts`): groups from two agents' `review: true` tables (a table without `review` is not listed; an archived agent's table is not listed); `reviewActs` with the cursor only → one act for the cursor row's agent; "selected rows of two agents make one act per agent": selected `[a|findings|R-1, b|findings|R-2, a|findings|R-3]`, key `a` → `[{ agent: "a", section: "findings", action: "apply", rows: ["R-1", "R-3"] }, { agent: "b", …, rows: ["R-2"] }]`; a key no group maps → `[]`. Layer tests: ␣ selects, `a` gives `review-acts` and clears the selection.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; the `Action` union gains `{ type: "review-acts"; acts: ReadonlyArray<{ agent; section; action; rows }> }`.
- [ ] **Step 4: Run** — `mise run verify` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(tui): the review queue`.

---

### Task 5: The palette

**Files:** Create `packages/view-tui/src/palette.ts`; modify `view.ts` (`Ui.palette?`), `layers.ts` (global `ctrl+k`; a `palette` layer, exclusive, above the popover? no — below `popover`, above everything else); test `packages/view-tui/test/palette.test.ts`.

**Interfaces — Produces:**
```ts
export interface PaletteEntry { readonly id: string; readonly glyph: string; readonly label: string; readonly detail: string; readonly go: { readonly main: Main; readonly viewing?: string } | { readonly command: string } }
/** Agents (live, rail order), then grid, review, zarg, then slash commands; filtered by the query (case-insensitive substring of the label). */
export const paletteEntries: (s: SessionState, query: string, commands: ReadonlyArray<{ readonly cmd: string; readonly desc: string }>) => ReadonlyArray<PaletteEntry>
// Ui gains
readonly palette?: { readonly query: string; readonly pick: number }
```
Palette layer (`when: ui.palette !== undefined`, `exclusive: true`): printable keys append to the query (`space` as a space), Backspace removes the last character, ↑↓ move `pick`, ⏎ goes (`goTo(main, viewing)` with `focus: "tile"`, `sheet: false`, or a slash command → `{ type: "command", text: cmd }`) and closes, Esc closes. Global `ctrl+k` opens it with an empty query.

- [ ] **Step 1: Tests** (`palette.test.ts`): empty query lists agents then `grid`, `review`, `zarg`, then commands; `tes` keeps only matches; no match gives `[]`; "the palette owns printable keys": with it open, `g`, `/`, `x`, `a` extend the query and give no action; ⏎ on an agent entry opens it; Esc closes; `ctrl+k` opens it from any focus.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (slash commands from `SLASH_COMMANDS` in `commands.ts`, passed by the layer).
- [ ] **Step 4: Run** — `mise run verify` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(tui): the ^k palette`.

---

### Task 6: Drawing the focuses

**Files:** Modify `packages/view-tui/src/app.tsx`; test `packages/view-tui/test/app.test.tsx`.

**Interfaces — Consumes:** Tasks 2–5.

- **Grid:** a header line: ` all agents` bold `accent` when focused, then `page N of M` and page dots (`●` current, `○` others) in `dim`; then `gridShape` rows of `gridShape` columns of cards, each a rounded box (`line`, `accent` when it is the cursor), `paddingLeft: 1`: glyph (its token) + name bold + context dim (fit); gauge (`accent`/`faint`, width card−14) + `done/total` dim; headline (`attention` when the card asks, else `text`); a blank line; recent lines (dim, fit); flex space; the action line `<key> <label>` in `faint` when the card has an action. A starting card shows `starting…` dim in place of the headline. No agents: `no agents yet · / to start one with zarg` dim, centred.
- **Review:** header ` review` bold `accent` + `N open · M agents` dim; per group a `Heading` (the agent's name) then its rows like a selectable table (gutter `▍`, `○`/`●`, the columns); none: `nothing to review` dim.
- **zarg focus:** the conversation as the sheet draws it, filling the focus area, with the header `zarg` and no `esc closes`.
- **Agent:** unchanged (plan 1), Esc now goes back.
- **Palette:** a rounded `accent` box (width 60, top 3) on `raised`: `› <query>▎`, a faint rule, the entries (glyph, label with the query's match bold, detail dim; the picked one on `selection`), or `nothing matches` dim.
- **Status line:** after the status, the first agent asking (`◆ <name> <reason>` in `attention`, fit) when there is one, then the hints.
- **Rail row click and palette go** keep using `openAgent` / `goTo`.
- `act` runs `review-acts` as one `session.act(a.agent, a.action, a.section, a.rows)` per entry.

- [ ] **Step 1: Tests** (app.test.tsx, `describe("focuses")`, at 130×32 and 80×24): arrival with a running plugin agent draws its card in the grid and no sheet; arrival with nothing working draws the grid behind an open sheet; ⏎ on a card opens its view and Esc returns to the grid; a declared card shows its headline, gauge and recent lines; the review focus lists findings of two agents and `a` sends one act per agent; `^k` then `tes` then ⏎ opens that agent; at 80×24 the grid is one column; the status line names the first agent asking.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `mise run verify` — Expected: PASS (update the remaining frame tests and snapshots after reading the diffs).
- [ ] **Step 5: Commit** — `feat(tui): draw the grid, review, zarg's focus and the palette`.

---

### Task 7: Rehearse's cards and review tables; docs; end to end

**Files:** Modify `packages/agent-rehearse/src/views.ts` (the tester's findings table `review: true`), `packages/agent-rehearse/src/index.ts` (card surfaces: `{ kind: "card", name: "tester", view: "tester", headline: "progress", recent: "steps", action: "apply" }`, `{ kind: "card", name: "run", view: "run", headline: "progress" }`), `packages/cli/test/tui.e2e.test.tsx`, `AGENTS.md`; test `packages/agent-rehearse/test/plugin.test.ts` (the manifest carries both cards and the review flag).

- [ ] **Step 1: Test** — the built manifest (`manifestOf`) has the two cards and `review: true` on the tester's findings table only (the run view's findings repeat the testers' and stay out of the queue).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; `AGENTS.md`: the view-tui line gains "the grid of agent cards is home (zarg's sheet open over it on arrival when no agent works), the review queue, the `^k` palette, `⇥` back"; the SDK line mentions cards and `review: true`.
- [ ] **Step 4: Run** — `mise run build:plugins && mise run verify` — Expected: PASS; update the e2e test's waits if its first frame is now the grid (the grant popover and zarg's question still show: nothing works at start, so the sheet is open).
- [ ] **Step 5: Commit** — `feat(rehearse): cards and review; docs: the focuses`.

## Self-review notes

- Spec coverage: the four focuses and the grid as home (Tasks 2, 3, 6), arrival (Task 2), paging, order, card content and the minimal card (Task 3), review (Task 4), the palette (Task 5), the back stack and keys (Task 2), the status line naming who asks (Task 6), cards and review contract with checks (Task 1), rehearse (Task 7), errors (starting…, blank slots, 80×24 one column, nothing matches: Tasks 3, 5, 6).
- Rulings to ledger when executing: "agents work" counts plugin agents only (zarg and RLMs are the conversation); the run view's findings stay out of the review queue (they repeat the testers').
