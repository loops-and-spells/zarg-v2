# Input Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every key in the shell has exactly one owner: a stack of input layers derived from state, dispatched top-down, with agents owning their own key mappings per platform.

**Architecture:** `@zarg/view` gains a platform-free input mechanism (`InputLayer`, `stackOf`, `dispatch`, `hintsOf`) and the reserved-key rules for agents' actions (`keys` per platform, view-level actions). `@zarg/view-tui` defines the shell's layers (global, slash, text, question picker, zarg tile, view tile, agents tile) and replaces its long `onKey` with `dispatch` over them; the status line's hints come from the top layer. The SDK and the host refuse action mappings on reserved keys.

**Tech Stack:** Bun (`mise x -- bun`), TypeScript, Effect 4 Schema, React 19, opentui 0.5.12.

**Spec:** `docs/superpowers/specs/2026-09-27-input-layers-design.md`

## Global Constraints

- `mise run verify` must pass before every commit; tools through `mise x -- bun …`.
- `@zarg/view`'s `.` export imports only `effect` (the portability test).
- Global keys, a closed list: Ctrl-C (stop; twice within 2 s exits), Ctrl-D (exit), Alt+←→↑↓ (tiles).
- Terminal reserved keys (agents may not map them): Ctrl-*, Alt-*, arrows, Tab, Shift-Tab, Enter, Esc, Space, PgUp, PgDn, `[`, `]`, `g`, `x`.
- `key: "a"` on an action stays shorthand for `keys: { terminal: "a" }`.
- Scrollboxes are never focusable; the renderer runs with `autoFocus: false` (already so).
- Never start a core or the TUI in the repo root; no live models.

## Review Focus

1. Typing a message containing `g`, `x`, `[`, space or an agent's action letter: every character lands in the input, nothing else fires. → Task 2, test "text layer owns printable keys".
2. The slash box open while a question waits: ↑↓ move the slash rows, not the picker; closing the box gives ↑↓ back to the picker. → Task 2, test "the slash box takes ↑↓ only while open".
3. A plugin whose manifest maps an action to `tab` or `ctrl+a`: refused at load with a reason, the plugin does not load. → Task 4, test "the host refuses an action mapped to a reserved key".
4. A view whose table has no action for a pressed letter while a view-level action uses it: the view-level action fires with no section. → Task 4, test "a view-level action fires from any section".
5. Keys while no tile layer applies (the view closed under focus "view"): nothing throws, focus falls back to zarg. → Task 2, test "focus on a closed view falls back to zarg".

---

### Task 1: The input mechanism (`@zarg/view/src/input.ts`)

**Files:** Create `packages/view/src/input.ts`; test `packages/view/test/input.test.ts`; modify `packages/view/src/index.ts`.

**Interfaces — Produces:**
```ts
export interface InputKey { readonly name: string; readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean; readonly sequence?: string }
export interface KeyHint { readonly keys: string; readonly does: string }
export type Handled<U, A> = { readonly ui: U; readonly action?: A }
export interface InputLayer<U, W, A> {
  readonly id: string
  /** On the stack now? */
  readonly when: (ui: U, world: W) => boolean
  /** What this layer does with its keys, for hints. */
  readonly hints: (ui: U, world: W) => ReadonlyArray<KeyHint>
  /** Handle the key, or pass it down. */
  readonly handle: (ui: U, world: W, key: InputKey) => Handled<U, A> | "pass"
}
/** The layers on the stack, top first (`layers` is given top first). */
export const stackOf = <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W) => layers.filter((l) => l.when(ui, world))
/** The key goes to the top layer; each layer handles it or passes it down; a key no layer owns does nothing. */
export const dispatch = <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W, key: InputKey): Handled<U, A> & { readonly by?: string } => {
  for (const l of stackOf(layers, ui, world)) {
    const r = l.handle(ui, world, key)
    if (r !== "pass") return { ...r, by: l.id }
  }
  return { ui }
}
/** The hints to show: the top layer's, then the next one's, until a layer that owns everything (`exclusive`). */
export const hintsOf = <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W, limit = 2): ReadonlyArray<KeyHint> =>
  stackOf(layers, ui, world).filter((l) => l.id !== "global").slice(0, limit).flatMap((l) => l.hints(ui, world))
/** A printable key: one character without Ctrl or Alt. */
export const printable = (key: InputKey) => key.ctrl !== true && key.meta !== true && (key.name.length === 1 || key.name === "space" || key.name === "backspace")
```

- [ ] **Step 1: Test** (`input.test.ts`): a stack of three fake layers (`top` passes everything but `x`, `mid` handles `up`, `bottom` handles all): `x` → `by: "top"`; `up` → `by: "mid"`; `z` → `by: "bottom"`; with `bottom.when` false, `z` → no `by`, ui unchanged; `hintsOf` returns the top two non-global layers' hints in order; `printable` true for `a`, `space`, `backspace`, false for `up`, `ctrl+a`, `alt+a`.
- [ ] **Step 2:** Run `mise //packages/view:test` — FAIL (no module).
- [ ] **Step 3:** Write `input.ts` as above; export from `index.ts`.
- [ ] **Step 4:** `mise run verify` — PASS.
- [ ] **Step 5:** Commit `feat(view): input layers: a stack derived from state, dispatched top-down`.

### Task 2: The shell's layers replace `onKey`

**Files:** Create `packages/view-tui/src/layers.ts`; modify `packages/view-tui/src/view.ts` (`onKey` becomes `dispatch(SHELL, …)`; the old branches move into layers), `packages/view-tui/src/app.tsx` (pass `draft` as world); test `packages/view-tui/test/layers.test.ts`; existing `view.test.ts` keeps passing.

**Interfaces:**
- Consumes: `InputLayer`, `dispatch`, `printable` (Task 1); today's `Ui`, `Action`, `onAgentsKey`, `onSlashKey`, `viewKeys`, `conversationKey`, `openHistory`, `attentionOf`.
- Produces: `SHELL: ReadonlyArray<InputLayer<Ui, ShellWorld, Action>>` (top first) and `type ShellWorld = { readonly s: SessionState; readonly now: number; readonly draft: string }`; `onKey(ui, s, key, now, draft?)` keeps its signature and returns `dispatch(SHELL, ui, { s, now, draft: draft ?? "" }, key)` (plus `draft` from the slash layer).

The layers, top first (each `when`, the keys it owns, everything else passes):
```ts
const global: Layer = { id: "global", when: () => true,
  handle: (ui, w, k) => k.ctrl && k.name === "d" ? { ui, action: { type: "exit" } }
    : k.ctrl && k.name === "c" ? (ui.lastCtrlC !== undefined && w.now - ui.lastCtrlC < EXIT_WINDOW_MS ? { ui, action: { type: "exit" } } : { ui: { ...ui, lastCtrlC: w.now }, action: { type: "stop" } })
    : k.meta && ARROWS.has(k.name) ? { ui: moveTile(ui, k.name) } : "pass", hints: () => [] }
const slash: Layer = { id: "slash", when: (ui, w) => slashActive(ui, w.s) && w.draft.startsWith("/"), handle: (ui, w, k) => onSlashKey(ui, k, w.draft) ?? "pass", hints: …Tab complete, ↑↓ pick, Enter run, Esc close }
const text: Layer = { id: "text", when: (ui, w) => inputFocused(ui, w.s) || otherFocused(ui, w.s),
  // Letters, space and Backspace are the input's own: the renderer's input gets them; nobody else does.
  handle: (ui, w, k) => printable(k) ? { ui } : k.name === "escape" && isChatting(ui, w.s) ? { ui: stopChatting(ui) } : k.name === "escape" && ui.other ? { ui: backToOptions(ui, w.s) } : "pass", hints: … }
const picker: Layer = { id: "picker", when: (ui, w) => ui.focus === "conversation" && w.s.thread.pendingInquiry !== undefined && ui.answered !== w.s.thread.pendingInquiry.id && !isChatting(ui, w.s),
  handle: (ui, w, k) => pickerKey(ui, w.s, k) /* up, down, return; else "pass" */, hints: … }
const zargTile: Layer = { id: "zarg", when: (ui) => ui.focus === "conversation",
  handle: (ui, w, k) => k.name === "pageup" || k.name === "pagedown" ? { ui, action: { type: "scroll-talk", delta: k.name === "pageup" ? -10 : 10 } } : k.name === "g" ? nextAttention(ui, w.s) : k.name === "tab" ? { ui: { ...ui, focus: "agents" } } : "pass", hints: … }
const viewTile: Layer = { id: "view", when: (ui, w) => ui.focus === "view" && ui.viewing !== undefined && w.s.thread.views?.[ui.viewing] !== undefined,
  handle: (ui, w, k) => k.name === "escape" ? { ui: closeView(ui) } : k.name === "g" ? nextAttention(ui, w.s) : viewKeysAction(ui, w.s, k) /* today's viewKeys mapping */, hints: … }
const agentsTile: Layer = { id: "agents", when: (ui) => ui.focus === "agents" || (ui.focus === "view" && ui.viewing === undefined),
  handle: (ui, w, k) => k.name === "tab" ? { ui: { ...ui, focus: "conversation" } } : k.name === "g" ? nextAttention(ui, w.s) : { ui: onAgentsKey(ui, w.s.thread.rlms, k) }, hints: … }
export const SHELL = [global, slash, text, picker, zargTile, viewTile, agentsTile]
```
(`moveTile`, `nextAttention`, `closeView`, `pickerKey`, `isChatting`, `stopChatting`, `backToOptions` are the existing branches of `onKey`, moved into named functions unchanged. The spec's table does not list Tab for the zarg and agents tiles; they keep today's Tab toggle so existing habits and tests hold — ledger this as a ruling.) A new action `{ type: "scroll-talk", delta }` scrolls zarg's messages (app.tsx: the messages scrollbox ref's `scrollBy`).

- [ ] **Step 1: Test** (`layers.test.ts`), one test per rule, each naming the layer that took the key (`by`):
  - "text layer owns printable keys": with the message input focused, `g`, `x`, `[`, `a`, `space` → `by: "text"`, no action, ui unchanged;
  - "Alt+arrows move tiles even while typing": `meta` right → `by: "global"`, focus changes;
  - "the slash box takes ↑↓ only while open": draft `/re` + question pending + input focused → `up` `by: "slash"`; draft `` (question shown, input hidden) → `up` `by: "picker"`;
  - "a question never takes keys from another tile": focus `view` with a question → `down` `by: "view"`; focus `agents` → `down` `by: "agents"`;
  - "PgUp scrolls zarg's messages": focus conversation, no question, input not focused → `pageup` gives `{ type: "scroll-talk", delta: -10 }`;
  - "focus on a closed view falls back to zarg": `focus: "view"`, `viewing` undefined → `down` is handled (`by` is `"agents"`, the fallback in `agentsTile.when`), nothing throws;
  - "a key no layer owns does nothing": focus agents, `z` → handled by agents with ui unchanged (onAgentsKey ignores it).
- [ ] **Step 2:** Run `mise //packages/view-tui:test` — FAIL (no `layers.ts`).
- [ ] **Step 3:** Move the branches into named functions, write `layers.ts`, make `onKey` call `dispatch(SHELL, …)`, return `draft` from the slash layer as today. In `app.tsx` handle `scroll-talk` (a ref on the messages scrollbox, `scrollBy(delta)`).
- [ ] **Step 4:** `mise run verify` — PASS, including every existing `view.test.ts` and `app.test.tsx` case.
- [ ] **Step 5:** Commit `refactor(tui): the shell's keys go through input layers`.

### Task 3: Hints from the top layer

**Files:** `packages/view-tui/src/app.tsx` (status line), `packages/view-tui/src/layers.ts` (each layer's `hints`), test in `app.test.tsx`.

- [ ] **Step 1: Test:** with a question pending and zarg focused, the status line shows the picker's hints (`↑↓ pick · Enter answer`); with the agents tile focused, the tree's (`↑↓ move · ←→ fold · Enter open`); with a view focused, the view's (`Tab sections · Esc close`).
- [ ] **Step 2:** Run — FAIL (today's hints are hard-coded per focus).
- [ ] **Step 3:** Status line: `hintsOf(SHELL, ui, world).map((h) => `${h.keys} ${h.does}`).join(" · ")`; each layer's `hints` returns its keys (the table in the spec).
- [ ] **Step 4:** `mise run verify` — PASS (update snapshots after reading the diff).
- [ ] **Step 5:** Commit `feat(tui): the status line shows the keys of the layers on top`.

### Task 4: Agents own their key mappings, per platform

**Files:** `packages/view/src/schema.ts` (`Action.keys`, view-level `actions` on the layout), `packages/view/src/layout.ts` (`defineView` accepts view-level actions; refuses reserved and duplicate keys), `packages/view/src/behaviour.ts` (`actionFor(view, ui, key, platform = "terminal")` reads `keys[platform] ?? key`, then view-level actions), `packages/view/src/keys.ts` (new: `RESERVED_TERMINAL`, `reservedFor(platform, key)`), `packages/plugin/src/server/host.ts` (`manifestProblem` refuses a view action mapped to a reserved terminal key or duplicated), tests in `packages/view/test/layout.test.ts`, `packages/view/test/behaviour.test.ts`, `packages/plugin/test/load-waiting.test.ts`.

**Interfaces — Produces:**
```ts
// schema.ts
export const Action = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  key: Schema.optionalKey(Schema.String), // shorthand for keys.terminal
  keys: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)), // platform → key, e.g. { terminal: "a", web: "mod+enter" }
  on: Schema.Literals(["selection", "row", "none"]),
})
// LayoutSchema gains `actions?: Action[]` (view-level, `on: "none"`)
// keys.ts
export const RESERVED_TERMINAL: ReadonlySet<string> = new Set(["up", "down", "left", "right", "tab", "shift+tab", "return", "enter", "escape", "space", "pageup", "pagedown", "[", "]", "g", "x"])
export const reservedFor = (platform: string, key: string) =>
  platform === "terminal" && (RESERVED_TERMINAL.has(key) || /^(ctrl|alt|meta|option)\+/.test(key))
export const keyFor = (a: { key?: string; keys?: Readonly<Record<string, string>> }, platform: string) => a.keys?.[platform] ?? (platform === "terminal" ? a.key : undefined)
```

- [ ] **Step 1: Tests:**
  - layout: `defineView` refuses an action with `key: "tab"`, with `keys: { terminal: "ctrl+a" }`, and two actions with key `a` in one view; accepts `keys: { web: "mod+enter" }` (another platform's mapping is kept);
  - behaviour: "a view-level action fires from any section" — view-level action `{ id: "rerun", keys: { terminal: "r" }, on: "none" }`: `actionFor(view, ui, "r")` → `{ section: undefined, action: "rerun", rows: [] }` whatever section has focus; a table action with `keys: { terminal: "a" }` works like `key: "a"`;
  - host: "the host refuses an action mapped to a reserved key" — a fixture plugin whose manifest view has an action `key: "tab"` (patch the manifest after the SDK build) fails to load with `"reserved"` in its agenda detail.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; the view tile's hints (Task 3) list the open agent's mapped actions for `terminal`.
- [ ] **Step 4:** `mise run verify` — PASS.
- [ ] **Step 5:** Commit `feat: agents own their key mappings, per platform; reserved keys refused`.

### Task 5: Docs

- [ ] `AGENTS.md`: in the `view` and `view-tui` lines, the input layers (keys go to the top layer; agents map their own keys per platform, never reserved ones). `mise run verify`; commit `docs: input layers`.

## Self-review notes

- Spec coverage: the model and dispatch (Task 1), the shell's layers and derived stack (Task 2), focus following state (already: inputs' `focused` from `inputFocused` / `otherFocused`; scrollboxes unfocusable), hints (Task 3), agents' per-platform mappings, view-level actions, reserved keys at build and load (Task 4).
- Deviation to ledger: the zarg and agents tiles keep Tab (toggle between them) though the spec's table omits it.
