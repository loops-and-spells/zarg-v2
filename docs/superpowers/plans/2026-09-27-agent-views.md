# Agent Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents own their window: each agent declares a view of typed, scrollable sections, pushes data into it, and every platform draws it; the terminal is the first platform.

**Architecture:** A new platform-free package `@zarg/view` holds the section schema, `defineView`, the AG-UI view reducer and the view behaviour (focus, tabs, rows, selection). Plugins declare views in their manifest and push data through the `agents.event` power; the core keeps each view (a `ViewStore` per thread), checks every push, and sends it as AG-UI `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` with `activityType: "zarg.view"`. The client folds those into `ThreadState.views`; the terminal shell moves into `@zarg/view-tui`, which draws each section kind in its own scrollbox, stacked by role.

**Tech Stack:** Bun (via `mise x -- bun`), TypeScript, Effect 4 (`Schema`), React 19, opentui 0.5.12 (`@opentui/react`), AG-UI 1.0 events, `react-dom/server` (test only).

**Spec:** `docs/superpowers/specs/2026-09-27-agent-views-design.md`

## Global Constraints

- Run every tool through mise: `mise x -- bun …`, `mise x -- bunx tsc`; tests spawn `process.execPath`, never a bare `bun`. Use `bun add` / `bun remove` from the right package directory; commit `bun.lock`.
- `mise run verify` typechecks and tests every package; it must pass before every commit.
- One package = one module; depend on packages by name (`"@zarg/<name>": "workspace:*"`), never by relative path across packages.
- `@zarg/view` (its `.` export) imports only `effect`; `@zarg/view/react` imports only `react` and `effect`. Neither imports `react-dom`, `@opentui/*`, `react-native` or `node:*`.
- Views carry no colours, glyphs, widths or heights. Tone is one of `normal`, `ok`, `warn`, `error`, `dim`, `accent`; role is one of `summary`, `primary`, `log`, `pinned`, `aside`.
- Section kinds: `stats`, `list`, `log`, `table`, `tabs`, `keyvalue`, `text`. Actions belong to tables: `{ id, label, key?, on: "selection" | "row" | "none" }`.
- AG-UI: `activityType: "zarg.view"`, `messageId: "<thread>:view:<agent>"`; set = `replace /data/<path>`; append = `add /data/<path>/lines/-` per line.
- Pushes for one agent within 100 ms go out as one delta; a `log` keeps its last 2000 lines.
- The view push travels over the existing `agents.event` power (scope `agents: true`); no new scope, no new grant.
- The client and the TUI never import `@zarg/core` or a `/server` subpath.
- Never print, log or commit a secret value; tests use variable names unique to the test. Tests never write to `~/.config/zarg` (the `ZARG_USER_DIR` preload).
- Do not start a zarg core or the TUI in the repository root; do not run live models or the GPU.
- Code comments and docs are plain prose; tag code implementing a card with `// @card <id>` only where a card exists (none here).

## Review Focus

1. A plugin appending thousands of log lines quickly: the view keeps the last 2000, deltas coalesce, the stream does not flood. → Task 5, test "a log keeps its last 2000 lines and pushes within the window go out as one delta".
2. A client that attaches mid-run replays the thread log (snapshot, then hundreds of deltas) and ends with the same view the core holds. → Task 7, test "replaying a view's events gives the view the core holds".
3. A plugin pushing to an agent it never started, or naming another plugin's agent: refused, nothing reaches the wire. → Task 5, test "a push for an agent this plugin did not start is refused".
4. A small terminal (80×20) with a tall pinned table: the pinned section never takes the whole window; every section keeps at least its title row. → Task 8, test "at 80×20 every section keeps its title and the pinned table stays within 40%".
5. A secret inside pushed view text (a plugin echoing an env value): redacted before it reaches the log or the wire. → Task 5, test "pushed text is redacted before it is stored or sent".

---

## File structure

```
packages/view/                        NEW @zarg/view
  package.json  mise.toml  tsconfig.json
  src/index.ts                        re-exports schema, layout, reducer, behaviour
  src/schema.ts                       Tone, Role, Action, Column, data schemas per kind, Layout schema
  src/layout.ts                       ViewSpec types, defineView, layoutOf, path/data typing, checkSet/checkAppend
  src/reducer.ts                      VIEW_ACTIVITY, ViewState, reduceView (AG-UI events → views)
  src/behaviour.ts                    ViewUi, ordered, focusNext, nextTab, moveRow, toggleSelect, actionFor
  src/react.ts                        useView hook (the "./react" export)
  test/schema.test.ts  test/layout.test.ts  test/reducer.test.ts  test/behaviour.test.ts
  test/portable.test.ts               no platform imports
  test/web.test.tsx                   one view rendered with react-dom/server

packages/view-tui/                    NEW @zarg/view-tui (moved from packages/cli/src/tui, plus views)
  package.json  mise.toml  tsconfig.json  bunfig.toml? (none needed)
  src/index.ts                        exports App, Meta, registerCommands, SLASH_COMMANDS …
  src/app.tsx  src/view.ts  src/commands.ts      moved from packages/cli/src/tui
  src/sections.tsx                    renderers: Record<SectionKind, Component>, AgentView (stacking by role)
  src/view-keys.ts                    keys in an agent view → behaviour calls / actions
  test/app.test.tsx (+ __snapshots__)  test/view.test.ts  test/commands.test.ts  test/boundary.test.ts   moved
  test/sections.test.tsx              agent view frames

packages/plugin-sdk/src/define.ts     views on PluginDef; agents.start view
packages/plugin-sdk/src/manifest.ts   views in the manifest
packages/plugin-sdk/src/services.ts   Views service (set, append) over agents.event
packages/plugin-sdk/src/build.ts      (no change: definePlugin validates)
packages/plugin/src/server/loaded.ts  Manifest.views
packages/core/src/events.ts           activitySnapshot/activityDelta take an activityType
packages/core/src/views.ts            NEW ViewStore: makeViews, threadViews, DEFAULT_LAYOUT
packages/core/src/rlm-view.ts         NEW RLM_LAYOUT, rlmLines (moved from the TUI's historyView)
packages/core/src/activity.ts         pushes the RLM view when given a ViewStore
packages/core/src/plugin-agents.ts    view start/set/append; step appends to the first log
packages/core/src/thread.ts, reconcile.ts, live.ts   pass views
packages/core/src/server.ts           Actions service (replaces Bodies); POST …/actions/:action {section?, rows}
packages/core/src/bodies.ts           DELETED in Task 9 (replaced by actions.ts)
packages/core/src/actions.ts          NEW makeActions
packages/client/src/state.ts          ThreadState.views; reduce zarg.view activities; Body types removed (Task 9)
packages/client/src/client.ts, session.ts   act(…, section, rows); body removed (Task 9)
packages/cli/src/tui/run.tsx          imports App from @zarg/view-tui
packages/plugin-rehearse/src/views.ts NEW TesterView, RunView
packages/plugin-rehearse/src/run.ts   pushes views; workers; body removed
packages/plugin-rehearse/src/index.ts views on the plugin; act with section; body removed
AGENTS.md                             packages list
```

---

### Task 1: Move the terminal shell into `@zarg/view-tui`

A pure move, no behaviour change: the TUI shell becomes its own package so later platform shells sit beside it.

**Files:**
- Create: `packages/view-tui/package.json`, `packages/view-tui/mise.toml`, `packages/view-tui/tsconfig.json`, `packages/view-tui/src/index.ts`
- Move (git mv): `packages/cli/src/tui/app.tsx` → `packages/view-tui/src/app.tsx`; `packages/cli/src/tui/view.ts` → `packages/view-tui/src/view.ts`; `packages/cli/src/tui/commands.ts` → `packages/view-tui/src/commands.ts`
- Move tests: `packages/cli/test/app.test.tsx` (and `__snapshots__/app.test.tsx.snap`), `view.test.ts`, `commands.test.ts`, `boundary.test.ts` → `packages/view-tui/test/`
- Modify: `packages/cli/src/tui/run.tsx`, `packages/cli/test/mount.test.tsx`, `packages/cli/test/tui.e2e.test.tsx`, `packages/cli/package.json`

**Interfaces:**
- Produces: package `@zarg/view-tui` exporting everything `app.tsx`, `view.ts` and `commands.ts` exported before (`App`, `Meta`, `Ui`, `initialUi`, `onKey`, `historyView`, `registerCommands`, `SLASH_COMMANDS`, …).

- [ ] **Step 1: Create the package files**

`packages/view-tui/package.json`:
```json
{
  "name": "@zarg/view-tui",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@opentui/core": "^0.5.12",
    "@opentui/react": "0.5.12",
    "@zarg/client": "workspace:*",
    "effect": "^4.0.0-rc.117",
    "react": "19"
  },
  "devDependencies": {
    "@types/react": "^19.3.0"
  }
}
```

`packages/view-tui/mise.toml`:
```toml
[tasks.typecheck]
run = "mise x -- bunx tsc"

[tasks.test]
run = "mise x -- bun test"
```

`packages/view-tui/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react"
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 2: Move the files with git**

```bash
mkdir -p packages/view-tui/src packages/view-tui/test/__snapshots__
git mv packages/cli/src/tui/app.tsx packages/view-tui/src/app.tsx
git mv packages/cli/src/tui/view.ts packages/view-tui/src/view.ts
git mv packages/cli/src/tui/commands.ts packages/view-tui/src/commands.ts
git mv packages/cli/test/app.test.tsx packages/view-tui/test/app.test.tsx
git mv packages/cli/test/__snapshots__/app.test.tsx.snap packages/view-tui/test/__snapshots__/app.test.tsx.snap
git mv packages/cli/test/view.test.ts packages/view-tui/test/view.test.ts
git mv packages/cli/test/commands.test.ts packages/view-tui/test/commands.test.ts
git mv packages/cli/test/boundary.test.ts packages/view-tui/test/boundary.test.ts
```

- [ ] **Step 3: Fix imports**

In the moved tests replace `../src/tui/` with `../src/`:
```bash
sed -i 's#\.\./src/tui/#../src/#g' packages/view-tui/test/app.test.tsx packages/view-tui/test/view.test.ts packages/view-tui/test/commands.test.ts
```
In `packages/view-tui/test/boundary.test.ts` the directory it scans becomes the package's `src`:
```ts
  const dir = join(import.meta.dir, "..", "src")
```
and its test name becomes `"the terminal shell never imports core or a server module"`.

`packages/view-tui/src/index.ts`:
```ts
export * from "./app"
export * from "./commands"
export * from "./view"
```

In `packages/cli/src/tui/run.tsx` replace
```ts
import { App } from "./app"
import type { Meta } from "./view"
```
with
```ts
import { App, type Meta } from "@zarg/view-tui"
```
In `packages/cli/test/tui.e2e.test.tsx` replace `import { App } from "../src/tui/app"` with `import { App } from "@zarg/view-tui"`.

Add the dependency (from `packages/cli`): `mise x -- bun add @zarg/view-tui@workspace:*`, then from the root `mise x -- bun install`.

- [ ] **Step 4: Run the moved tests**

Run: `mise //packages/view-tui:typecheck && mise //packages/view-tui:test && mise //packages/cli:test`
Expected: PASS, the same test counts as before the move (view-tui gets the app, view, commands and boundary tests; cli keeps cli, mount and tui.e2e).

- [ ] **Step 5: Verify and commit**

```bash
mise run verify
git add -A packages/view-tui packages/cli bun.lock
git commit -m "refactor: the terminal shell is its own package, @zarg/view-tui"
```

---

### Task 2: `@zarg/view`: the section schema and `defineView`

**Files:**
- Create: `packages/view/package.json`, `mise.toml`, `tsconfig.json`, `src/index.ts`, `src/schema.ts`, `src/layout.ts`
- Test: `packages/view/test/schema.test.ts`, `packages/view/test/layout.test.ts`, `packages/view/test/portable.test.ts`

**Interfaces:**
- Produces:
  - `schema.ts`: `Tone`, `Role`, `Action`, `Column`, `StatsData`, `ListData`, `LogLine`, `LogData`, `TableData`, `KeyValueData`, `TextData`, `DATA` (kind → data schema), `LayoutSchema`, types `Layout`, `LayoutSection`, `LayoutLeaf`, `SectionKind`, `LeafKind`.
  - `layout.ts`: types `LeafSpec`, `SectionSpec`, `ViewSpec`, `ViewDef<S>`, `SectionPath<S>`, `LogPath<S>`, `DataAt<S, P>`; functions `defineView<const S>(name: string, sections: S): ViewDef<S>`, `layoutOf(def: ViewDef<ViewSpec>): Layout`, `leafAt(layout: Layout, path: string): LayoutLeaf | undefined`, `checkSet(layout, path, data): { ok: true; data: unknown } | { ok: false; error: string }`, `checkAppend(layout, path, lines): { ok: true; lines: ReadonlyArray<LogLine> } | { ok: false; error: string }`.

- [ ] **Step 1: Package files**

`packages/view/package.json`:
```json
{
  "name": "@zarg/view",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./react": "./src/react.ts"
  },
  "dependencies": {
    "effect": "^4.0.0-rc.117"
  },
  "peerDependencies": {
    "react": "19"
  },
  "devDependencies": {
    "@types/react": "^19.3.0"
  }
}
```
`packages/view/mise.toml`: the same two tasks as Task 1. `packages/view/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx" },
  "include": ["src", "test"]
}
```
From the root: `mise x -- bun install`.

- [ ] **Step 2: Write the failing tests**

`packages/view/test/schema.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DATA, LayoutSchema } from "../src"

describe("section data", () => {
  test("each kind's data round trips and rejects the wrong shape", () => {
    const ok = {
      stats: { items: [{ label: "steps", value: "14/22" }], progress: { done: 14, total: 22 } },
      list: { items: [{ id: "s3", text: "story 3", state: "busy" }] },
      log: { lines: [{ text: "UX-1 ok", tone: "dim" }] },
      table: { rows: [{ id: "R-1", cells: { id: "R-1", note: "unclear" } }] },
      keyvalue: { pairs: [{ key: "card", value: "UX-1" }] },
      text: { markdown: "**done**" },
    } as const
    for (const [kind, data] of Object.entries(ok)) {
      const s = DATA[kind as keyof typeof DATA]
      expect(Schema.decodeUnknownSync(s as Schema.Codec<unknown, unknown>)(data)).toEqual(data)
    }
    expect(() => Schema.decodeUnknownSync(DATA.table as Schema.Codec<unknown, unknown>)({ rows: [{ id: "x", cells: { a: 1 } }] })).toThrow()
    expect(() => Schema.decodeUnknownSync(DATA.log as Schema.Codec<unknown, unknown>)({ lines: [{ text: "x", tone: "red" }] })).toThrow()
  })

  test("a layout is plain data: kinds, roles, columns and actions, nothing about looks", () => {
    const layout = {
      name: "tester",
      sections: [
        { id: "progress", kind: "stats", role: "summary" },
        { id: "review", kind: "tabs", role: "pinned", tabs: [{ id: "findings", kind: "table", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] }] },
      ],
    }
    expect(Schema.decodeUnknownSync(LayoutSchema)(layout)).toEqual(layout as never)
    expect(() => Schema.decodeUnknownSync(LayoutSchema)({ name: "x", sections: [{ id: "a", kind: "stats", role: "left" }] })).toThrow()
  })
})
```

`packages/view/test/layout.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { checkAppend, checkSet, defineView, layoutOf } from "../src"

const Tester = defineView("tester", {
  progress: { kind: "stats", role: "summary" },
  steps: { kind: "log", role: "log", title: "Steps" },
  review: {
    kind: "tabs",
    role: "pinned",
    tabs: {
      findings: { kind: "table", title: "Findings", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] },
      likes: { kind: "table", title: "Likes", columns: [{ id: "id", label: "id" }] },
    },
  },
})

describe("defineView", () => {
  test("a view becomes a layout: sections in declared order, tabs as nested leaves", () => {
    const l = layoutOf(Tester)
    expect(l.name).toBe("tester")
    expect(l.sections.map((s) => [s.id, s.kind, s.role])).toEqual([["progress", "stats", "summary"], ["steps", "log", "log"], ["review", "tabs", "pinned"]])
    const review = l.sections[2]!
    expect(review.kind === "tabs" && review.tabs.map((t) => t.id)).toEqual(["findings", "likes"])
  })

  test("a malformed view is refused where it is defined", () => {
    expect(() => defineView("Bad Name", { a: { kind: "log", role: "log" } })).toThrow(/view name/)
    expect(() => defineView("v", { "a.b": { kind: "log", role: "log" } })).toThrow(/section id/)
    expect(() => defineView("v", { t: { kind: "tabs", role: "pinned", tabs: {} } })).toThrow(/no tabs/)
    expect(() =>
      defineView("v", { t: { kind: "table", role: "primary", columns: [], actions: [{ id: "x", label: "X", on: "row" }, { id: "x", label: "Y", on: "row" }] } }),
    ).toThrow(/action x/)
  })

  test("typed paths and data: a wrong section or wrong data does not compile", () => {
    type Set = <P extends import("../src").SectionPath<typeof Tester.sections>>(p: P, d: import("../src").DataAt<typeof Tester.sections, P>) => void
    const set: Set = () => {}
    set("progress", { items: [] })
    set("review.findings", { rows: [] })
    // @ts-expect-error: no such section
    set("workers", { items: [] })
    // @ts-expect-error: a stats section takes items, not rows
    set("progress", { rows: [] })
    // @ts-expect-error: a tabs section has no data of its own
    set("review", { rows: [] })
    expect(true).toBe(true)
  })
})

describe("checking pushes against a layout", () => {
  const l = layoutOf(Tester)
  test("set accepts data of the section's kind and refuses the rest", () => {
    expect(checkSet(l, "review.findings", { rows: [{ id: "R-1", cells: { id: "R-1" } }] })).toMatchObject({ ok: true })
    expect(checkSet(l, "progress", { rows: [] })).toMatchObject({ ok: false, error: expect.stringContaining("progress") })
    expect(checkSet(l, "nope", { items: [] })).toMatchObject({ ok: false, error: expect.stringContaining("no section nope") })
    expect(checkSet(l, "review", { rows: [] })).toMatchObject({ ok: false })
  })
  test("append goes only to logs", () => {
    expect(checkAppend(l, "steps", [{ text: "x" }])).toMatchObject({ ok: true })
    expect(checkAppend(l, "progress", [{ text: "x" }])).toMatchObject({ ok: false, error: expect.stringContaining("not a log") })
  })
})
```

`packages/view/test/portable.test.ts`:
```ts
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Web, native and terminal renderers all build on this package: it must not tie itself to one platform.
test("@zarg/view imports no platform module", () => {
  const dir = join(import.meta.dir, "..", "src")
  const offenders = readdirSync(dir).flatMap((f) =>
    [...readFileSync(join(dir, f), "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((spec) => spec === "react-dom" || spec.startsWith("react-dom/") || spec.startsWith("@opentui/") || spec === "react-native" || spec.startsWith("node:") || (f !== "react.ts" && spec === "react"))
      .map((spec) => `${f}: ${spec}`),
  )
  expect(offenders).toEqual([])
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `mise //packages/view:test`
Expected: FAIL: `Cannot find module '../src'` (schema and layout tests); the portable test passes on an empty `src` only once `src` exists, so create the directory first and expect it to fail on the imports of the other two files.

- [ ] **Step 4: Implement `schema.ts`**

```ts
import { Schema } from "effect"

/** What a line or cell means; each platform picks its own colour for it. */
export const Tone = Schema.Literals(["normal", "ok", "warn", "error", "dim", "accent"])
/** What a section is for; each platform places roles its own way. */
export const Role = Schema.Literals(["summary", "primary", "log", "pinned", "aside"])
/** An action on a table: on the selected rows (or the highlighted one), on the highlighted row, or on none. */
export const Action = Schema.Struct({ id: Schema.String, label: Schema.String, key: Schema.optionalKey(Schema.String), on: Schema.Literals(["selection", "row", "none"]) })
export const Column = Schema.Struct({ id: Schema.String, label: Schema.String })

export const StatsData = Schema.Struct({
  items: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String, tone: Schema.optionalKey(Tone) })),
  progress: Schema.optionalKey(Schema.Struct({ done: Schema.Number, total: Schema.Number })),
})
export const ListData = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, text: Schema.String, detail: Schema.optionalKey(Schema.String), state: Schema.optionalKey(Schema.Literals(["busy", "waiting", "done", "flagged"])), tone: Schema.optionalKey(Tone) }),
  ),
})
export const LogLine = Schema.Struct({ text: Schema.String, tone: Schema.optionalKey(Tone), at: Schema.optionalKey(Schema.Number) })
export const LogData = Schema.Struct({ lines: Schema.Array(LogLine) })
export const TableData = Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String, cells: Schema.Record(Schema.String, Schema.String), tone: Schema.optionalKey(Tone) })) })
export const KeyValueData = Schema.Struct({ pairs: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })) })
export const TextData = Schema.Struct({ markdown: Schema.String })

/** The data each leaf kind holds. `tabs` has none of its own: its tabs do. */
export const DATA = { stats: StatsData, list: ListData, log: LogData, table: TableData, keyvalue: KeyValueData, text: TextData } as const
export type LeafKind = keyof typeof DATA
export type SectionKind = LeafKind | "tabs"
export type LogLine = typeof LogLine.Type

const leafFields = {
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  columns: Schema.optionalKey(Schema.Array(Column)),
  selectable: Schema.optionalKey(Schema.Boolean),
  actions: Schema.optionalKey(Schema.Array(Action)),
}
export const LayoutLeaf = Schema.Struct({ ...leafFields, kind: Schema.Literals(["stats", "list", "log", "table", "keyvalue", "text"]) })
export const LayoutSection = Schema.Union([
  Schema.Struct({ ...leafFields, kind: Schema.Literals(["stats", "list", "log", "table", "keyvalue", "text"]), role: Role }),
  Schema.Struct({ id: Schema.String, title: Schema.optionalKey(Schema.String), kind: Schema.Literal("tabs"), role: Role, tabs: Schema.Array(LayoutLeaf) }),
])
/** A view as the manifest and the wire carry it. */
export const LayoutSchema = Schema.Struct({ name: Schema.String, sections: Schema.Array(LayoutSection) })
export type Layout = typeof LayoutSchema.Type
export type LayoutSection = typeof LayoutSection.Type
export type LayoutLeaf = typeof LayoutLeaf.Type
```

- [ ] **Step 5: Implement `layout.ts`**

```ts
import { Schema } from "effect"
import { DATA, type Layout, type LayoutLeaf, type LayoutSection, type LeafKind, type LogLine, LogData } from "./schema"

type ActionSpec = { readonly id: string; readonly label: string; readonly key?: string; readonly on: "selection" | "row" | "none" }
type ColumnSpec = { readonly id: string; readonly label: string }
type Role = "summary" | "primary" | "log" | "pinned" | "aside"
export type LeafSpec =
  | { readonly kind: "stats" | "list" | "log" | "keyvalue" | "text"; readonly title?: string }
  | { readonly kind: "table"; readonly title?: string; readonly columns: ReadonlyArray<ColumnSpec>; readonly selectable?: boolean; readonly actions?: ReadonlyArray<ActionSpec> }
export type SectionSpec = (LeafSpec & { readonly role: Role }) | { readonly kind: "tabs"; readonly role: Role; readonly title?: string; readonly tabs: Readonly<Record<string, LeafSpec>> }
export type ViewSpec = Readonly<Record<string, SectionSpec>>
export interface ViewDef<S extends ViewSpec> {
  readonly name: string
  readonly sections: S
}

/** Every leaf's path: a section's id, or `<tabs id>.<tab id>`. */
export type SectionPath<S extends ViewSpec> = {
  [K in keyof S & string]: S[K] extends { readonly kind: "tabs"; readonly tabs: infer T } ? `${K}.${keyof T & string}` : K
}[keyof S & string]
type LeafAt<S extends ViewSpec, P extends string> = P extends `${infer K}.${infer T}`
  ? S[K] extends { readonly kind: "tabs"; readonly tabs: infer Tb } ? (T extends keyof Tb ? Tb[T] : never) : never
  : S[P]
/** The data a leaf at `P` takes. */
export type DataAt<S extends ViewSpec, P extends string> = LeafAt<S, P> extends { readonly kind: infer K } ? (K extends LeafKind ? (typeof DATA)[K]["Type"] : never) : never
/** Paths of the view's logs (the only sections `append` reaches). */
export type LogPath<S extends ViewSpec> = { [P in SectionPath<S>]: LeafAt<S, P> extends { readonly kind: "log" } ? P : never }[SectionPath<S>]

const NAME = /^[a-z][a-z0-9-]*$/
const ID = /^[a-z][a-zA-Z0-9-]*$/

const checkLeaf = (view: string, path: string, leaf: LeafSpec) => {
  const ids = leaf.kind === "table" ? (leaf.actions ?? []).map((a) => a.id) : []
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup !== undefined) throw new Error(`view ${view}: action ${dup} appears twice in ${path}`)
}

/** Declare a view: its sections in order, each with a kind and a role. Checked here, so a plugin's build refuses a bad one. */
export const defineView = <const S extends ViewSpec>(name: string, sections: S): ViewDef<S> => {
  if (!NAME.test(name)) throw new Error(`view name "${name}" must be kebab-case`)
  for (const [id, s] of Object.entries(sections)) {
    if (!ID.test(id)) throw new Error(`view ${name}: section id "${id}" must be letters, digits or dashes, starting with a letter`)
    if (s.kind === "tabs") {
      const tabs = Object.entries(s.tabs)
      if (tabs.length === 0) throw new Error(`view ${name}: tabs section ${id} has no tabs`)
      for (const [tid, t] of tabs) {
        if (!ID.test(tid)) throw new Error(`view ${name}: tab id "${tid}" in ${id} must be letters, digits or dashes`)
        checkLeaf(name, `${id}.${tid}`, t)
      }
    } else checkLeaf(name, id, s)
  }
  return { name, sections }
}

const leafOf = (id: string, l: LeafSpec): LayoutLeaf => ({
  id,
  kind: l.kind,
  ...(l.title !== undefined ? { title: l.title } : {}),
  ...(l.kind === "table" ? { columns: l.columns, ...(l.selectable !== undefined ? { selectable: l.selectable } : {}), ...(l.actions !== undefined ? { actions: l.actions } : {}) } : {}),
})

/** The view as data: what the manifest carries and the core sends. */
export const layoutOf = (def: ViewDef<ViewSpec>): Layout => ({
  name: def.name,
  sections: Object.entries(def.sections).map(([id, s]): LayoutSection =>
    s.kind === "tabs"
      ? { id, kind: "tabs", role: s.role, ...(s.title !== undefined ? { title: s.title } : {}), tabs: Object.entries(s.tabs).map(([tid, t]) => leafOf(tid, t)) }
      : { ...leafOf(id, s), role: s.role },
  ),
})

/** The leaf at `path` (`id` or `tabs.tab`), or undefined. */
export const leafAt = (layout: Layout, path: string): LayoutLeaf | undefined => {
  const [id, tab] = path.split(".")
  const s = layout.sections.find((x) => x.id === id)
  if (s === undefined) return undefined
  if (s.kind === "tabs") return tab === undefined ? undefined : s.tabs.find((t) => t.id === tab)
  return tab === undefined ? s : undefined
}

/** A push of `data` to `path`, checked against the section's kind (a plugin is untrusted). */
export const checkSet = (layout: Layout, path: string, data: unknown): { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string } => {
  const leaf = leafAt(layout, path)
  if (leaf === undefined) return { ok: false, error: `view ${layout.name} has no section ${path}` }
  const r = Schema.decodeUnknownExit(DATA[leaf.kind] as Schema.Codec<unknown, unknown>)(data)
  return r._tag === "Success" ? { ok: true, data: r.value } : { ok: false, error: `view ${layout.name}: ${path} is a ${leaf.kind} section; its data does not fit` }
}

/** Lines appended to a log, checked. */
export const checkAppend = (layout: Layout, path: string, lines: unknown): { readonly ok: true; readonly lines: ReadonlyArray<LogLine> } | { readonly ok: false; readonly error: string } => {
  const leaf = leafAt(layout, path)
  if (leaf === undefined) return { ok: false, error: `view ${layout.name} has no section ${path}` }
  if (leaf.kind !== "log") return { ok: false, error: `view ${layout.name}: ${path} is not a log` }
  const r = Schema.decodeUnknownExit(LogData)({ lines })
  return r._tag === "Success" ? { ok: true, lines: r.value.lines } : { ok: false, error: `view ${layout.name}: lines for ${path} do not fit` }
}
```

`packages/view/src/index.ts` (for now):
```ts
export * from "./layout"
export * from "./schema"
```

- [ ] **Step 6: Run the tests**

Run: `mise //packages/view:typecheck && mise //packages/view:test`
Expected: PASS (schema 2, layout 5, portable 1). The `@ts-expect-error` lines must each be needed: typecheck fails if one is not.

- [ ] **Step 7: Commit**

```bash
mise run verify
git add -A packages/view bun.lock
git commit -m "feat(view): the section schema and defineView"
```

---

### Task 3: `@zarg/view`: the reducer, the behaviour and `useView`

**Files:**
- Create: `packages/view/src/reducer.ts`, `packages/view/src/behaviour.ts`, `packages/view/src/react.ts`
- Modify: `packages/view/src/index.ts`, `packages/view/package.json` (devDependency `react-dom`)
- Test: `packages/view/test/reducer.test.ts`, `packages/view/test/behaviour.test.ts`, `packages/view/test/web.test.tsx`

**Interfaces:**
- Consumes: `Layout`, `LayoutLeaf`, `leafAt` (Task 2).
- Produces:
  - `reducer.ts`: `VIEW_ACTIVITY = "zarg.view"`, `LOG_KEEP = 2000`, `viewMessageId(thread: string, agent: string): string` (= `${thread}:view:${agent}`), `interface ViewState { readonly agent: string; readonly layout: Layout; readonly data: Readonly<Record<string, unknown>> }`, `type Views = Readonly<Record<string, ViewState>>`, `reduceView(views: Views, e: ViewEvent): Views` where `ViewEvent = { readonly type: string; readonly activityType?: unknown; readonly content?: unknown; readonly patch?: unknown }`, `isViewEvent(e): boolean`.
  - `behaviour.ts`: `interface ViewUi { readonly focus: number; readonly tabs: Readonly<Record<string, number>>; readonly rows: Readonly<Record<string, number>>; readonly selected: Readonly<Record<string, ReadonlyArray<string>>> }`, `initialViewUi`, `ordered(layout): ReadonlyArray<LayoutSection>`, `focused(view, ui)`, `leafOf(view, ui, sectionId): { path: string; leaf: LayoutLeaf } | undefined`, `rowsOf(view, path): ReadonlyArray<{ id: string }>`, `focusNext(view, ui, dir: 1 | -1)`, `nextTab(view, ui, dir: 1 | -1)`, `moveRow(view, ui, delta: number)`, `toggleSelect(view, ui)`, `actionFor(view, ui, key: string): { section: string; action: string; rows: ReadonlyArray<string> } | undefined`, `afterAction(ui, section): ViewUi` (clears that table's selection).
  - `react.ts`: `useView(view: ViewState | undefined)` → `{ ui: ViewUi; focusNext; nextTab; moveRow; toggleSelect; action(key) }`.

- [ ] **Step 1: Write the failing tests**

`packages/view/test/reducer.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { defineView, LOG_KEEP, layoutOf, reduceView, VIEW_ACTIVITY, type Views } from "../src"

const layout = layoutOf(defineView("tester", { progress: { kind: "stats", role: "summary" }, steps: { kind: "log", role: "log" }, review: { kind: "tabs", role: "pinned", tabs: { findings: { kind: "table", columns: [{ id: "id", label: "id" }] } } } }))
const snap = (agent: string) => ({ type: "ACTIVITY_SNAPSHOT", activityType: VIEW_ACTIVITY, content: { agent, layout, data: {} } })
const delta = (agent: string, patch: ReadonlyArray<Record<string, unknown>>) => ({ type: "ACTIVITY_DELTA", activityType: VIEW_ACTIVITY, content: { agent }, patch })

describe("reduceView", () => {
  test("a snapshot then set and append deltas build the view", () => {
    let v: Views = {}
    v = reduceView(v, snap("rehearse:tester-1"))
    v = reduceView(v, delta("rehearse:tester-1", [{ op: "replace", path: "/data/progress", value: { items: [{ label: "steps", value: "1/2" }] } }]))
    v = reduceView(v, delta("rehearse:tester-1", [{ op: "add", path: "/data/steps/lines/-", value: { text: "a" } }, { op: "add", path: "/data/steps/lines/-", value: { text: "b" } }]))
    v = reduceView(v, delta("rehearse:tester-1", [{ op: "replace", path: "/data/review.findings", value: { rows: [{ id: "R-1", cells: { id: "R-1" } }] } }]))
    expect(v["rehearse:tester-1"]!.data).toEqual({
      progress: { items: [{ label: "steps", value: "1/2" }] },
      steps: { lines: [{ text: "a" }, { text: "b" }] },
      "review.findings": { rows: [{ id: "R-1", cells: { id: "R-1" } }] },
    })
  })

  test("a delta for a view with no snapshot is ignored; other activities are not views", () => {
    expect(reduceView({}, delta("x", [{ op: "replace", path: "/data/progress", value: {} }]))).toEqual({})
    expect(reduceView({}, { type: "ACTIVITY_SNAPSHOT", activityType: "zarg.rlm", content: { rlms: {} } })).toEqual({})
  })

  test("a log keeps its last lines only", () => {
    let v = reduceView({}, snap("a"))
    const patch = Array.from({ length: LOG_KEEP + 5 }, (_, i) => ({ op: "add", path: "/data/steps/lines/-", value: { text: String(i) } }))
    v = reduceView(v, delta("a", patch))
    const lines = (v.a!.data.steps as { lines: ReadonlyArray<{ text: string }> }).lines
    expect(lines).toHaveLength(LOG_KEEP)
    expect(lines[0]!.text).toBe("5")
  })

  test("a new snapshot replaces the view (the agent started again)", () => {
    let v = reduceView({}, snap("a"))
    v = reduceView(v, delta("a", [{ op: "add", path: "/data/steps/lines/-", value: { text: "old" } }]))
    v = reduceView(v, snap("a"))
    expect(v.a!.data).toEqual({})
  })
})
```

`packages/view/test/behaviour.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { actionFor, defineView, focusNext, initialViewUi, layoutOf, moveRow, nextTab, ordered, toggleSelect, type ViewState } from "../src"

const layout = layoutOf(
  defineView("tester", {
    review: {
      kind: "tabs",
      role: "pinned",
      tabs: {
        findings: { kind: "table", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }, { id: "open", label: "Open", key: "o", on: "row" }] },
        likes: { kind: "table", columns: [{ id: "id", label: "id" }] },
      },
    },
    steps: { kind: "log", role: "log" },
    progress: { kind: "stats", role: "summary" },
  }),
)
const view: ViewState = {
  agent: "t",
  layout,
  data: { "review.findings": { rows: [{ id: "R-1", cells: {} }, { id: "R-2", cells: {} }, { id: "R-3", cells: {} }] }, "review.likes": { rows: [{ id: "L-1", cells: {} }] } },
}

describe("view behaviour", () => {
  test("sections are ordered by role: summary, primary, log, aside, pinned", () => {
    expect(ordered(layout).map((s) => s.id)).toEqual(["progress", "steps", "review"])
  })

  test("focus cycles through sections both ways", () => {
    const f1 = focusNext(view, initialViewUi, 1)
    expect(f1.focus).toBe(1)
    expect(focusNext(view, f1, 1).focus).toBe(2)
    expect(focusNext(view, { ...initialViewUi, focus: 2 }, 1).focus).toBe(0)
    expect(focusNext(view, initialViewUi, -1).focus).toBe(2)
  })

  test("in a focused table: rows move, space selects, an action takes the selection or the highlighted row", () => {
    let ui = { ...initialViewUi, focus: 2 }
    ui = moveRow(view, ui, 1)
    expect(actionFor(view, ui, "a")).toEqual({ section: "review.findings", action: "apply", rows: ["R-2"] })
    ui = toggleSelect(view, ui)
    ui = moveRow(view, ui, 1)
    ui = toggleSelect(view, ui)
    expect(actionFor(view, ui, "a")).toEqual({ section: "review.findings", action: "apply", rows: ["R-2", "R-3"] })
    // A row action takes the highlighted row even with a selection.
    expect(actionFor(view, ui, "o")).toEqual({ section: "review.findings", action: "open", rows: ["R-3"] })
    expect(moveRow(view, ui, 10).rows["review.findings"]).toBe(2)
    expect(actionFor(view, ui, "z")).toBeUndefined()
  })

  test("tabs switch within the focused tabs section; the likes table has no actions", () => {
    const ui = nextTab(view, { ...initialViewUi, focus: 2 }, 1)
    expect(ui.tabs.review).toBe(1)
    expect(actionFor(view, ui, "a")).toBeUndefined()
    expect(nextTab(view, ui, 1).tabs.review).toBe(0)
  })
})
```

`packages/view/test/web.test.tsx`:
```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { defineView, layoutOf, ordered, type ViewState } from "../src"
import { useView } from "../src/react"

// A throwaway web renderer: proof that a view renders on a platform other than the terminal, from the contract alone.
const WebView = (props: { view: ViewState }) => {
  const v = useView(props.view)
  return (
    <main>
      {ordered(props.view.layout).map((s, i) => (
        <section key={s.id} data-role={s.role} data-focused={v.ui.focus === i}>
          <h2>{s.title ?? s.id}</h2>
          {s.kind === "log" ? (props.view.data[s.id] as { lines: ReadonlyArray<{ text: string }> } | undefined)?.lines.map((l, j) => <p key={j}>{l.text}</p>) : null}
        </section>
      ))}
    </main>
  )
}

test("a view renders to HTML with react-dom from the contract alone", () => {
  const view: ViewState = { agent: "a", layout: layoutOf(defineView("demo", { steps: { kind: "log", role: "log", title: "Steps" }, top: { kind: "stats", role: "summary" } })), data: { steps: { lines: [{ text: "UX-1 ok" }] } } }
  const html = renderToStaticMarkup(<WebView view={view} />)
  expect(html).toBe('<main><section data-role="summary" data-focused="true"><h2>top</h2></section><section data-role="log" data-focused="false"><h2>Steps</h2><p>UX-1 ok</p></section></main>')
})
```

Add the test-only dependency (from `packages/view`): `mise x -- bun add -d react-dom@19 @types/react-dom react@19`.

- [ ] **Step 2: Run them to see them fail**

Run: `mise //packages/view:test`
Expected: FAIL: `reduceView` / `ordered` / `useView` are not exported.

- [ ] **Step 3: Implement `reducer.ts`**

```ts
import type { Layout } from "./schema"

/** The AG-UI activity type views travel as. */
export const VIEW_ACTIVITY = "zarg.view"
/** A log keeps this many of its last lines; older ones stay in the transcript. */
export const LOG_KEEP = 2000
export const viewMessageId = (thread: string, agent: string) => `${thread}:view:${agent}`

export interface ViewState {
  readonly agent: string
  readonly layout: Layout
  /** Each leaf's data by path (`id` or `tabs.tab`). */
  readonly data: Readonly<Record<string, unknown>>
}
export type Views = Readonly<Record<string, ViewState>>
export interface ViewEvent {
  readonly type: string
  readonly activityType?: unknown
  readonly content?: unknown
  readonly patch?: unknown
}

export const isViewEvent = (e: ViewEvent) => (e.type === "ACTIVITY_SNAPSHOT" || e.type === "ACTIVITY_DELTA") && e.activityType === VIEW_ACTIVITY

type Op = { readonly op: string; readonly path: string; readonly value?: unknown }
const PATH = /^\/data\/([^/]+)(\/lines\/-)?$/

/** Fold one AG-UI event into the views; events that are not views leave them as they are. */
export const reduceView = (views: Views, e: ViewEvent): Views => {
  if (!isViewEvent(e)) return views
  const agent = String((e.content as { agent?: unknown } | undefined)?.agent ?? "")
  if (e.type === "ACTIVITY_SNAPSHOT") {
    const c = e.content as { layout: Layout; data?: Record<string, unknown> }
    return { ...views, [agent]: { agent, layout: c.layout, data: c.data ?? {} } }
  }
  const v = views[agent]
  if (v === undefined) return views
  const data: Record<string, unknown> = { ...v.data }
  for (const p of (e.patch as ReadonlyArray<Op>) ?? []) {
    const m = PATH.exec(p.path)
    if (m === null) continue
    const key = m[1]!.replace(/~1/g, "/").replace(/~0/g, "~")
    if (m[2] !== undefined && p.op === "add") {
      const lines = [...((data[key] as { lines?: ReadonlyArray<unknown> } | undefined)?.lines ?? []), p.value]
      data[key] = { lines: lines.length > LOG_KEEP ? lines.slice(lines.length - LOG_KEEP) : lines }
    } else if (m[2] === undefined && (p.op === "replace" || p.op === "add")) data[key] = p.value
  }
  return { ...views, [agent]: { ...v, data } }
}
```

- [ ] **Step 4: Implement `behaviour.ts`**

```ts
import { leafAt } from "./layout"
import type { LayoutLeaf, LayoutSection } from "./schema"
import type { ViewState } from "./reducer"

/** What the operator has done in a view: the focused section, each tabs section's tab, each table's cursor and selection. */
export interface ViewUi {
  readonly focus: number
  readonly tabs: Readonly<Record<string, number>>
  readonly rows: Readonly<Record<string, number>>
  readonly selected: Readonly<Record<string, ReadonlyArray<string>>>
}
export const initialViewUi: ViewUi = { focus: 0, tabs: {}, rows: {}, selected: {} }

const ROLE_ORDER = ["summary", "primary", "log", "aside", "pinned"] as const
/** Sections in the order platforms read them: by role, declared order within a role. */
export const ordered = (layout: ViewState["layout"]): ReadonlyArray<LayoutSection> =>
  ROLE_ORDER.flatMap((role) => layout.sections.filter((s) => s.role === role))

export const focused = (view: ViewState, ui: ViewUi): LayoutSection | undefined => {
  const all = ordered(view.layout)
  return all[Math.min(ui.focus, all.length - 1)]
}

/** The leaf a section shows now (its current tab for tabs). */
export const leafOf = (view: ViewState, ui: ViewUi, sectionId: string): { readonly path: string; readonly leaf: LayoutLeaf } | undefined => {
  const s = view.layout.sections.find((x) => x.id === sectionId)
  if (s === undefined) return undefined
  if (s.kind !== "tabs") return { path: s.id, leaf: s }
  const t = s.tabs[Math.min(ui.tabs[s.id] ?? 0, s.tabs.length - 1)]
  return t === undefined ? undefined : { path: `${s.id}.${t.id}`, leaf: leafAt(view.layout, `${s.id}.${t.id}`)! }
}

export const rowsOf = (view: ViewState, path: string): ReadonlyArray<{ readonly id: string }> => {
  const d = view.data[path] as { rows?: ReadonlyArray<{ id: string }>; items?: ReadonlyArray<{ id: string }> } | undefined
  return d?.rows ?? d?.items ?? []
}

const current = (view: ViewState, ui: ViewUi) => {
  const s = focused(view, ui)
  return s === undefined ? undefined : leafOf(view, ui, s.id)
}

export const focusNext = (view: ViewState, ui: ViewUi, dir: 1 | -1): ViewUi => {
  const n = view.layout.sections.length
  return n === 0 ? ui : { ...ui, focus: (((ui.focus + dir) % n) + n) % n }
}

export const nextTab = (view: ViewState, ui: ViewUi, dir: 1 | -1): ViewUi => {
  const s = focused(view, ui)
  if (s === undefined || s.kind !== "tabs") return ui
  const n = s.tabs.length
  return { ...ui, tabs: { ...ui.tabs, [s.id]: ((((ui.tabs[s.id] ?? 0) + dir) % n) + n) % n } }
}

export const moveRow = (view: ViewState, ui: ViewUi, delta: number): ViewUi => {
  const c = current(view, ui)
  if (c === undefined || (c.leaf.kind !== "table" && c.leaf.kind !== "list")) return ui
  const last = Math.max(0, rowsOf(view, c.path).length - 1)
  return { ...ui, rows: { ...ui.rows, [c.path]: Math.max(0, Math.min(last, (ui.rows[c.path] ?? 0) + delta)) } }
}

export const toggleSelect = (view: ViewState, ui: ViewUi): ViewUi => {
  const c = current(view, ui)
  if (c === undefined || c.leaf.kind !== "table" || c.leaf.selectable !== true) return ui
  const row = rowsOf(view, c.path)[ui.rows[c.path] ?? 0]
  if (row === undefined) return ui
  const sel = ui.selected[c.path] ?? []
  return { ...ui, selected: { ...ui.selected, [c.path]: sel.includes(row.id) ? sel.filter((x) => x !== row.id) : [...sel, row.id] } }
}

/** The action a key triggers in the focused table, with the rows it applies to; undefined when none. */
export const actionFor = (view: ViewState, ui: ViewUi, key: string): { readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string> } | undefined => {
  const c = current(view, ui)
  if (c === undefined || c.leaf.kind !== "table") return undefined
  const a = (c.leaf.actions ?? []).find((x) => x.key === key)
  if (a === undefined) return undefined
  const row = rowsOf(view, c.path)[ui.rows[c.path] ?? 0]
  const sel = ui.selected[c.path] ?? []
  const rows = a.on === "none" ? [] : a.on === "row" ? (row !== undefined ? [row.id] : []) : sel.length > 0 ? sel : row !== undefined ? [row.id] : []
  return a.on !== "none" && rows.length === 0 ? undefined : { section: c.path, action: a.id, rows }
}

/** After an action ran: that table's selection clears. */
export const afterAction = (ui: ViewUi, section: string): ViewUi => ({ ...ui, selected: { ...ui.selected, [section]: [] } })
```

- [ ] **Step 5: Implement `react.ts`**

```ts
import { useState } from "react"
import { actionFor, afterAction, focusNext, initialViewUi, moveRow, nextTab, toggleSelect, type ViewUi } from "./behaviour"
import type { ViewState } from "./reducer"

/** A view's behaviour for any React platform: the state and the calls keys, clicks or touches make. */
export const useView = (view: ViewState | undefined) => {
  const [ui, setUi] = useState<ViewUi>(initialViewUi)
  const on = (f: (v: ViewState, u: ViewUi) => ViewUi) => () => view !== undefined && setUi((u) => f(view, u))
  return {
    ui,
    focusNext: (dir: 1 | -1) => on((v, u) => focusNext(v, u, dir))(),
    nextTab: (dir: 1 | -1) => on((v, u) => nextTab(v, u, dir))(),
    moveRow: (delta: number) => on((v, u) => moveRow(v, u, delta))(),
    toggleSelect: on(toggleSelect),
    /** The action this key triggers (the caller sends it), clearing the table's selection. */
    action: (key: string) => {
      const a = view === undefined ? undefined : actionFor(view, ui, key)
      if (a !== undefined) setUi((u) => afterAction(u, a.section))
      return a
    },
  }
}
```

`packages/view/src/index.ts`:
```ts
export * from "./behaviour"
export * from "./layout"
export * from "./reducer"
export * from "./schema"
```

- [ ] **Step 6: Run the tests**

Run: `mise //packages/view:typecheck && mise //packages/view:test`
Expected: PASS (reducer 4, behaviour 4, web 1, plus Task 2's 8).

- [ ] **Step 7: Commit**

```bash
mise run verify
git add -A packages/view bun.lock
git commit -m "feat(view): the view reducer, behaviour and useView"
```

---

### Task 4: Plugins declare views and push to them (SDK and manifests)

**Files:**
- Modify: `packages/plugin-sdk/src/define.ts`, `packages/plugin-sdk/src/manifest.ts`, `packages/plugin-sdk/src/services.ts`, `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/package.json`
- Modify: `packages/plugin/src/server/loaded.ts` (Manifest.views)
- Test: `packages/plugin-sdk/test/views.test.ts`

**Interfaces:**
- Consumes: `defineView`, `layoutOf`, `ViewDef`, `ViewSpec`, `SectionPath`, `LogPath`, `DataAt`, `Layout`, `LogLine` (Task 2).
- Produces:
  - `PluginDef.views?: ReadonlyArray<ViewDef<any>>`; `Manifest.views?: ReadonlyArray<Layout>`.
  - `Agents.start` takes `view?: string`.
  - SDK service `Views`: `set<S extends ViewSpec, P extends SectionPath<S>>(agent: string, view: ViewDef<S>, path: P, data: DataAt<S, P>): Effect<void, PluginFailure>` and `append<S extends ViewSpec, P extends LogPath<S>>(agent: string, view: ViewDef<S>, path: P, lines: ReadonlyArray<LogLine>): Effect<void, PluginFailure>`, both over the `agents.event` power as `{ event: "set", id, section, data }` / `{ event: "append", id, section, lines }`.
  - `@zarg/plugin-sdk` re-exports `defineView`.

- [ ] **Step 1: Write the failing test**

`packages/plugin-sdk/test/views.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { defineView, definePlugin, Views } from "../src"
import { manifestOf } from "../src/manifest"

const Tester = defineView("tester", { steps: { kind: "log", role: "log" }, progress: { kind: "stats", role: "summary" } })

describe("plugin views", () => {
  test("a plugin's views travel in its manifest as layouts", () => {
    const p = definePlugin({ name: "demo", service: "Demo", archetype: "service", config: Schema.Struct({}), scopes: { agents: true }, views: [Tester], methods: {}, make: Effect.succeed({}) })
    expect(manifestOf(p).views).toEqual([{ name: "tester", sections: [{ id: "steps", kind: "log", role: "log" }, { id: "progress", kind: "stats", role: "summary" }] }])
  })

  test("two views with one name are refused", () => {
    expect(() => definePlugin({ name: "demo", service: "Demo", archetype: "service", config: Schema.Struct({}), scopes: {}, views: [Tester, Tester], methods: {}, make: Effect.succeed({}) })).toThrow(/view tester/)
  })

  test("Views pushes over the agents power, typed by the view", async () => {
    const calls: Array<[string, unknown]> = []
    const p = definePlugin({
      name: "demo",
      service: "Demo",
      archetype: "service",
      config: Schema.Struct({}),
      scopes: { agents: true },
      views: [Tester],
      methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.Null } },
      make: Effect.gen(function* () {
        const views = yield* Views
        return {
          go: () =>
            Effect.gen(function* () {
              yield* views.set("t-1", Tester, "progress", { items: [{ label: "steps", value: "1/2" }] })
              yield* views.append("t-1", Tester, "steps", [{ text: "ok" }])
              return null
            }),
        }
      }),
    })
    const methods = p.serve({ call: async (name: string, args: unknown) => (calls.push([name, args]), null) } as never)
    await methods.go!({})
    expect(calls).toEqual([
      ["agents.event", { event: "set", id: "t-1", section: "progress", data: { items: [{ label: "steps", value: "1/2" }] } }],
      ["agents.event", { event: "append", id: "t-1", section: "steps", lines: [{ text: "ok" }] }],
    ])
    if (false as boolean) {
      const views = null as unknown as Views["Service"]
      // @ts-expect-error: progress is not a log
      views.append("t", Tester, "progress", [])
      // @ts-expect-error: no section named workers
      views.set("t", Tester, "workers", { items: [] })
    }
  })
})
```
Check first how `serve` expects `raw` (read `packages/plugin-sdk/src/services.ts` `RawPowers` and the existing `sdk.test.ts` for the shape used there); adjust the fake `raw` in this test to that shape before running.

- [ ] **Step 2: Run to see it fail**

Run: `mise //packages/plugin-sdk:test test/views.test.ts`
Expected: FAIL: `defineView` / `Views` are not exported.

- [ ] **Step 3: Implement**

From `packages/plugin-sdk`: `mise x -- bun add @zarg/view@workspace:*`.

`services.ts`: add after `Agents`:
```ts
import type { DataAt, LogLine, LogPath, SectionPath, ViewDef, ViewSpec } from "@zarg/view"

/** Push data into this plugin's agents' views (scope `agents: true`): typed by the view the agent started with. */
export class Views extends Context.Service<Views, {
  readonly set: <S extends ViewSpec, P extends SectionPath<S>>(agent: string, view: ViewDef<S>, path: P, data: DataAt<S, P>) => Effect.Effect<void, PluginFailure>
  readonly append: <S extends ViewSpec, P extends LogPath<S>>(agent: string, view: ViewDef<S>, path: P, lines: ReadonlyArray<LogLine>) => Effect.Effect<void, PluginFailure>
}>()("@zarg/plugin-sdk/Views") {}
```
Change `Agents.start`'s argument to `{ readonly id: string; readonly parent?: string; readonly title: string; readonly task: string; readonly view?: string }`.
In `servicesFrom`, add:
```ts
  views: Views.of({
    set: (agent, _view, path, data) => Effect.asVoid(power(raw, "agents.event", { event: "set", id: agent, section: path, data })),
    append: (agent, _view, path, lines) => Effect.asVoid(power(raw, "agents.event", { event: "append", id: agent, section: path, lines })),
  }),
```
In `define.ts`: add `readonly views?: ReadonlyArray<ViewDef<any>>` to `PluginDef` (import `type ViewDef` from `@zarg/view`); in `definePlugin`, before `serve`:
```ts
  const names = (def.views ?? []).map((v) => v.name)
  const twice = names.find((n, i) => names.indexOf(n) !== i)
  if (twice !== undefined) throw new Error(`plugin ${def.name}: view ${twice} is defined twice`)
```
and provide the `Views` service wherever `serve` builds the layer of services from `servicesFrom(raw)` (add `Layer.succeed(Views, s.views)` next to the `Agents` one; read `serve` to find the exact list).
In `manifest.ts`: `import { type Layout, layoutOf } from "@zarg/view"`; add `readonly views?: ReadonlyArray<Layout>` to `Manifest`; in `manifestOf` add `...(p.views !== undefined && p.views.length > 0 ? { views: p.views.map(layoutOf) } : {}),`.
In `index.ts`: `export { defineView } from "@zarg/view"` and export `Views` with the other services.
In `packages/plugin/src/server/loaded.ts`, add to `Manifest`: `readonly views?: ReadonlyArray<{ readonly name: string; readonly sections: ReadonlyArray<unknown> }>` (the host passes layouts through; the core checks them).

- [ ] **Step 4: Run the tests**

Run: `mise //packages/plugin-sdk:typecheck && mise //packages/plugin-sdk:test`
Expected: PASS, including the two `@ts-expect-error` lines.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add -A packages/plugin-sdk packages/plugin bun.lock
git commit -m "feat(sdk): plugins declare views and push data to them"
```

---

### Task 5: The core's ViewStore, and plugin agents' views

**Files:**
- Create: `packages/core/src/views.ts`
- Modify: `packages/core/src/events.ts`, `packages/core/src/plugin-agents.ts`, `packages/core/src/live.ts`, `packages/core/package.json` (dep `@zarg/view`)
- Test: `packages/core/test/views.test.ts`, `packages/core/test/plugin-agents.test.ts` (extend)

**Interfaces:**
- Consumes: `Layout`, `checkSet`, `checkAppend`, `VIEW_ACTIVITY`, `LOG_KEEP`, `viewMessageId`, `LayoutSchema` (Tasks 2–3); `ThreadLog` (`append`, `redact`).
- Produces:
  - `events.ts`: `activitySnapshot(messageId, content, activityType = ACTIVITY_TYPE)`, `activityDelta(messageId, patch, activityType = ACTIVITY_TYPE, content?)`.
  - `views.ts`: `DEFAULT_LAYOUT: Layout` (one `log` section `history`, role `log`), `makeViews(log: ThreadLog, threadId: string, opts?: { delayMs?: number })` returning `{ start(agent: string, layout: Layout): void; set(agent: string, path: string, data: unknown): void; append(agent: string, path: string, lines: unknown): void; has(agent: string): boolean; layout(agent: string): Layout | undefined; flush(): void }` (set/append throw `Error` with a readable message when refused); `threadViews(log, threadId): ReturnType<typeof makeViews>` (one per log and thread).
  - `plugin-agents.ts`: `pluginAgents(log, threadId, layoutOf: (plugin: string, view: string) => Layout | undefined)` handling `start` (with `view?`), `status`, `step` (also appends to the view's first log), `end`, `set`, `append`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/views.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { defineView, layoutOf, LOG_KEEP } from "@zarg/view"
import { makeLog } from "../src/log"
import { makeViews } from "../src/views"

const layout = layoutOf(defineView("tester", { progress: { kind: "stats", role: "summary" }, steps: { kind: "log", role: "log" } }))
const setup = async (redact: (t: string) => string = (t) => t) => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-views-")), redact))
  const views = makeViews(log, "main", { delayMs: 20 })
  const events = () => log.all().filter((e) => (e as { activityType?: string }).activityType === "zarg.view")
  return { log, views, events }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("the ViewStore", () => {
  test("start sends the layout as a snapshot; a set goes out as a replace delta", async () => {
    const { views, events } = await setup()
    views.start("rehearse:tester-1", layout)
    views.set("rehearse:tester-1", "progress", { items: [{ label: "steps", value: "1/2" }] })
    await sleep(40)
    const [snap, delta] = events() as ReadonlyArray<Record<string, any>>
    expect(snap).toMatchObject({ type: "ACTIVITY_SNAPSHOT", messageId: "main:view:rehearse:tester-1", content: { agent: "rehearse:tester-1", layout, data: {} } })
    expect(delta).toMatchObject({ type: "ACTIVITY_DELTA", patch: [{ op: "replace", path: "/data/progress", value: { items: [{ label: "steps", value: "1/2" }] } }] })
  })

  test("a push that does not fit its section is refused, and nothing is sent", async () => {
    const { views, events } = await setup()
    views.start("a", layout)
    expect(() => views.set("a", "progress", { rows: [] })).toThrow(/progress/)
    expect(() => views.append("a", "progress", [{ text: "x" }])).toThrow(/not a log/)
    expect(() => views.set("nobody", "progress", { items: [] })).toThrow(/no view/)
    await sleep(40)
    expect(events()).toHaveLength(1)
  })

  test("a log keeps its last 2000 lines and pushes within the window go out as one delta", async () => {
    const { views, events } = await setup()
    views.start("a", layout)
    for (let i = 0; i < LOG_KEEP + 10; i++) views.append("a", "steps", [{ text: String(i) }])
    views.set("a", "progress", { items: [] })
    await sleep(40)
    const deltas = events().filter((e) => e.type === "ACTIVITY_DELTA")
    expect(deltas).toHaveLength(1)
    // The delta carries only what the view keeps: the last LOG_KEEP lines, then the set.
    const patch = (deltas[0] as { patch: ReadonlyArray<{ op: string; path: string; value: { text?: string } }> }).patch
    expect(patch.filter((p) => p.path === "/data/steps/lines/-")).toHaveLength(LOG_KEEP)
    expect(patch[0]!.value.text).toBe("10")
  })

  test("pushed text is redacted before it is stored or sent", async () => {
    const { views, events } = await setup((t) => t.replaceAll("s3cr3t-view-test", "<redacted>"))
    views.start("a", layout)
    views.append("a", "steps", [{ text: "key s3cr3t-view-test" }])
    await sleep(40)
    expect(JSON.stringify(events())).not.toContain("s3cr3t-view-test")
  })
})
```

Extend `packages/core/test/plugin-agents.test.ts` (read it first; reuse its log setup) with:
```ts
  test("a plugin agent starts with its declared view; step lines go to its first log; set and append reach it", async () => {
    const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-pa-")), (t) => t))
    const tester = layoutOf(defineView("tester", { steps: { kind: "log", role: "log" }, progress: { kind: "stats", role: "summary" } }))
    const on = pluginAgents(log, "main", (plugin, view) => (plugin === "rehearse" && view === "tester" ? tester : undefined))
    on("rehearse", { event: "start", id: "tester-1", title: "tester", task: "The operator", view: "tester" })
    on("rehearse", { event: "step", id: "tester-1", text: "UX-1 ok" })
    on("rehearse", { event: "set", id: "tester-1", section: "progress", data: { items: [] } })
    threadViews(log, "main").flush()
    const views = log.all().filter((e) => (e as { activityType?: string }).activityType === "zarg.view") as ReadonlyArray<Record<string, any>>
    expect(views[0]).toMatchObject({ type: "ACTIVITY_SNAPSHOT", content: { agent: "rehearse:tester-1", layout: tester } })
    expect(views[1]!.patch).toEqual([{ op: "add", path: "/data/steps/lines/-", value: { text: "UX-1 ok" } }, { op: "replace", path: "/data/progress", value: { items: [] } }])
  })

  test("a push for an agent this plugin did not start is refused, and so is an undeclared view", async () => {
    const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-pa-")), (t) => t))
    const on = pluginAgents(log, "main", () => undefined)
    on("other", { event: "start", id: "x", title: "t", task: "t" })
    expect(() => on("rehearse", { event: "append", id: "x", section: "history", lines: [{ text: "hi" }] })).toThrow(/no view/)
    expect(() => on("rehearse", { event: "start", id: "y", title: "t", task: "t", view: "missing" })).toThrow(/declares no view missing/)
  })

  test("an agent started without a view gets the default: its step lines in one log", async () => {
    const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-pa-")), (t) => t))
    const on = pluginAgents(log, "main", () => undefined)
    on("p", { event: "start", id: "a", title: "t", task: "t" })
    on("p", { event: "step", id: "a", text: "one" })
    threadViews(log, "main").flush()
    const snap = log.all().find((e) => e.type === "ACTIVITY_SNAPSHOT" && (e as { activityType?: string }).activityType === "zarg.view") as Record<string, any>
    expect(snap.content.layout).toEqual(DEFAULT_LAYOUT)
  })
```
with imports `import { defineView, layoutOf } from "@zarg/view"` and `import { DEFAULT_LAYOUT, threadViews } from "../src/views"`.

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/core && mise x -- bun test test/views.test.ts test/plugin-agents.test.ts`
Expected: FAIL: `../src/views` does not exist.

- [ ] **Step 3: Implement**

From `packages/core`: `mise x -- bun add @zarg/view@workspace:*`.

`events.ts`: change the two activity helpers:
```ts
export const activitySnapshot = (messageId: string, content: Record<string, unknown>, activityType = ACTIVITY_TYPE): Draft => ({
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId,
  activityType,
  content,
})

export const activityDelta = (messageId: string, patch: ReadonlyArray<Record<string, unknown>>, activityType = ACTIVITY_TYPE, content?: Record<string, unknown>): Draft => ({
  type: EventType.ACTIVITY_DELTA,
  messageId,
  activityType,
  patch,
  ...(content !== undefined ? { content } : {}),
})
```
(If `@ag-ui/core`'s `ActivityDeltaEvent` type rejects `content`, keep the agent in the message id only and have the client reducer read it from `messageId`: in that case change `reduceView` to take the agent from `messageId.split(":view:")[1]` and update its tests. Prefer the type-checked path; ledger the ruling.)

`views.ts`:
```ts
import { Effect } from "effect"
import { checkAppend, checkSet, type Layout, LOG_KEEP, VIEW_ACTIVITY, viewMessageId } from "@zarg/view"
import * as E from "./events"
import type { ThreadLog } from "./log"

/** An agent that declared no view: its step lines in one log. */
export const DEFAULT_LAYOUT: Layout = { name: "default", sections: [{ id: "history", kind: "log", role: "log" }] }

const DELAY_MS = 100
const redactDeep = (v: unknown, redact: (t: string) => string): unknown =>
  typeof v === "string" ? redact(v) : Array.isArray(v) ? v.map((x) => redactDeep(x, redact)) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, redact)])) : v
const seg = (path: string) => path.replaceAll("~", "~0").replaceAll("/", "~1")

/**
 * Every agent view in one thread: checked pushes, kept state, and AG-UI events (a snapshot at start, then deltas
 * coalesced per agent within `delayMs`). Views live here, so they outlive the process that drew them.
 */
export const makeViews = (log: ThreadLog, threadId: string, opts: { readonly delayMs?: number } = {}) => {
  const states = new Map<string, { layout: Layout; data: Record<string, unknown> }>()
  const pending = new Map<string, Array<Record<string, unknown>>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const send = (agent: string) => {
    const patch = pending.get(agent)
    pending.delete(agent)
    if (patch === undefined || patch.length === 0) return
    // A log's lines beyond what the view keeps would be dropped by every client anyway.
    const kept = new Map<string, number>()
    const trimmed = [...patch].reverse().filter((p) => {
      if (!String(p.path).endsWith("/lines/-")) return true
      const n = (kept.get(String(p.path)) ?? 0) + 1
      kept.set(String(p.path), n)
      return n <= LOG_KEEP
    }).reverse()
    Effect.runSync(log.append(threadId, E.activityDelta(viewMessageId(threadId, agent), trimmed, VIEW_ACTIVITY, { agent })))
  }
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    for (const agent of [...pending.keys()]) send(agent)
  }
  const queue = (agent: string, ops: ReadonlyArray<Record<string, unknown>>) => {
    pending.set(agent, [...(pending.get(agent) ?? []), ...ops])
    if (timer === undefined) {
      timer = setTimeout(flush, opts.delayMs ?? DELAY_MS)
      timer.unref?.()
    }
  }
  const state = (agent: string) => {
    const s = states.get(agent)
    if (s === undefined) throw new Error(`agent ${agent} has no view (start it first)`)
    return s
  }
  return {
    start: (agent: string, layout: Layout) => {
      // Anything still queued for an earlier run of this agent goes first.
      send(agent)
      states.set(agent, { layout, data: {} })
      Effect.runSync(log.append(threadId, E.activitySnapshot(viewMessageId(threadId, agent), { agent, layout, data: {} }, VIEW_ACTIVITY)))
    },
    set: (agent: string, path: string, data: unknown) => {
      const s = state(agent)
      const r = checkSet(s.layout, path, redactDeep(data, log.redact))
      if (!r.ok) throw new Error(r.error)
      s.data[path] = r.data
      queue(agent, [{ op: "replace", path: `/data/${seg(path)}`, value: r.data }])
    },
    append: (agent: string, path: string, lines: unknown) => {
      const s = state(agent)
      const r = checkAppend(s.layout, path, redactDeep(lines, log.redact))
      if (!r.ok) throw new Error(r.error)
      const all = [...((s.data[path] as { lines?: ReadonlyArray<unknown> } | undefined)?.lines ?? []), ...r.lines]
      s.data[path] = { lines: all.length > LOG_KEEP ? all.slice(all.length - LOG_KEEP) : all }
      queue(agent, r.lines.map((l) => ({ op: "add", path: `/data/${seg(path)}/lines/-`, value: l })))
    },
    has: (agent: string) => states.has(agent),
    layout: (agent: string) => states.get(agent)?.layout,
    flush,
  }
}
export type ViewStore = ReturnType<typeof makeViews>

const perLog = new WeakMap<ThreadLog, Map<string, ViewStore>>()
/** The one ViewStore of a thread (plugin agents and RLMs of that thread share it). */
export const threadViews = (log: ThreadLog, threadId: string): ViewStore => {
  let m = perLog.get(log)
  if (m === undefined) perLog.set(log, (m = new Map()))
  let v = m.get(threadId)
  if (v === undefined) m.set(threadId, (v = makeViews(log, threadId)))
  return v
}
```
Note: the thrown message for an unknown agent must contain "no view" (tests match `/no view/`).

`plugin-agents.ts`: extend `AgentEvent` with `view?: string` on start and two events:
```ts
  | { readonly event: "set"; readonly id: string; readonly section: string; readonly data: unknown }
  | { readonly event: "append"; readonly id: string; readonly section: string; readonly lines: unknown }
```
change the signature to `pluginAgents(log: ThreadLog, threadId: string, layoutOf: (plugin: string, view: string) => Layout | undefined = () => undefined)`, create `const views = threadViews(log, threadId)` once, and at the top of the returned function after the id checks:
```ts
    const id = `${plugin}:${e.id}`
    if (e.event === "set") return views.set(id, e.section, e.data)
    if (e.event === "append") return views.append(id, e.section, e.lines)
    if (e.event === "start") {
      const layout = e.view === undefined ? DEFAULT_LAYOUT : layoutOf(plugin, e.view)
      if (layout === undefined) throw new Error(`plugin ${plugin} declares no view ${e.view}`)
      views.start(id, layout)
    }
    if (e.event === "step") {
      const first = views.layout(id)?.sections.find((s) => s.kind === "log")
      if (first !== undefined) views.append(id, first.id, [{ text: e.text }])
    }
```
(then the existing mapping to `a.observe(ev)` for start/status/step/end; `set` and `append` return before it). A `step` for an agent never started keeps its current behaviour (the activity row) and skips the view.

`live.ts`: where `control.setAgents(pluginAgents(log, "main"))` is called, pass the manifests' layouts:
```ts
    control.setAgents(
      pluginAgents(log, "main", (plugin, view) => {
        const l = host.manifests.find((m) => m.name === plugin)?.views?.find((v) => v.name === view)
        return l === undefined ? undefined : Schema.decodeUnknownSync(LayoutSchema)(l)
      }),
    )
```
(import `LayoutSchema` from `@zarg/view`; a manifest's view that fails to decode throws at start, which the power reports to the plugin).

- [ ] **Step 4: Run the tests**

Run: `mise //packages/core:typecheck && cd packages/core && mise x -- bun test test/views.test.ts test/plugin-agents.test.ts test/service-powers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add -A packages/core bun.lock
git commit -m "feat(core): a ViewStore per thread; plugin agents start and fill their views"
```

---

### Task 6: The RLM's view

**Files:**
- Create: `packages/core/src/rlm-view.ts`
- Modify: `packages/core/src/activity.ts`, `packages/core/src/thread.ts:163`, `packages/core/src/reconcile.ts:39`
- Test: `packages/core/test/rlm-view.test.ts`

**Interfaces:**
- Consumes: `ViewStore`, `threadViews` (Task 5); the transcript record shapes `activity.ts` writes (`start`, `step`, `model`, `call`, `atomize`, `plan`, `extend`).
- Produces: `RLM_LAYOUT: Layout` (sections `status` stats/summary, `task` text/primary, `history` log/log); `rlmLines(record: Record<string, any>): ReadonlyArray<LogLine>`; `makeActivity(log, threadId, messageId?, views?: ViewStore)`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/rlm-view.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeActivity } from "../src/activity"
import { makeLog } from "../src/log"
import { RLM_LAYOUT, rlmLines } from "../src/rlm-view"
import { makeViews } from "../src/views"

describe("the RLM's view", () => {
  test("history lines read as the history view did: model turns, calls, cells", () => {
    expect(rlmLines({ type: "model", turn: 2, modelMs: 1500, promptTokens: 1200, completionTokens: 80 })).toEqual([{ text: "turn 2 · model 1.5s · 1,200 → 80 tokens", tone: "accent" }])
    expect(rlmLines({ type: "call", service: "Graph", method: "show", params: { id: "UX-1" }, ms: 4, ok: false, failure: { _tag: "NotFound", message: "no UX-1" } })).toEqual([
      { text: '  Graph.show {"id":"UX-1"}  4ms  failed: NotFound: no UX-1', tone: "error" },
    ])
    expect(rlmLines({ type: "step", text: "", cells: [{ code: "yield* x", ok: true, output: "", ms: 3 }] })).toEqual([
      { text: "  cell ok 3ms", tone: "dim" },
      { text: "    │ yield* x", tone: "dim" },
    ])
  })

  test("an RLM run fills its view: status, task with the current cell, history", async () => {
    const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-rlmv-")), (t) => t))
    const views = makeViews(log, "main", { delayMs: 1 })
    const a = makeActivity(log, "main", undefined, views)
    a.observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "Fix S-1", scope: {}, depth: 0, budget: { turns: 25, tokens: 0, wallMs: 0 } } as never)
    a.observe({ type: "step", id: "rlm-1", turn: 1, text: "looking", cells: [{ code: "yield* Graph.show({ id: \"S-1\" })", ok: true, output: "ok", ms: 5 }] } as never)
    a.observe({ type: "turn", id: "rlm-1", turn: 1, tokens: 900 } as never)
    views.flush()
    expect(views.layout("rlm-1")).toEqual(RLM_LAYOUT)
    const events = log.all().filter((e) => (e as { activityType?: string }).activityType === "zarg.view") as ReadonlyArray<Record<string, any>>
    const patch = events.flatMap((e) => e.patch ?? [])
    expect(patch.find((p: { path: string }) => p.path === "/data/task").value.markdown).toContain('yield* Graph.show({ id: "S-1" })')
    expect(patch.filter((p: { path: string }) => p.path === "/data/history/lines/-").map((p: { value: { text: string } }) => p.value.text)).toContain("  looking")
    expect(patch.findLast((p: { path: string }) => p.path === "/data/status").value.items).toContainEqual({ label: "turns", value: "1/25" })
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/core && mise x -- bun test test/rlm-view.test.ts`
Expected: FAIL: `../src/rlm-view` does not exist.

- [ ] **Step 3: Implement `rlm-view.ts`**

Port `historyView` from `packages/view-tui/src/view.ts` (the `HISTORY_CODE_LINES`, `HISTORY_OUTPUT_LINES`, `clip`, `firstLines` helpers and the `switch`) into `rlmLines`, mapping its `kind` to a tone: `zarg` → no tone (normal), `dim` → `"dim"`, `error` → `"error"`, `accent` → `"accent"`. Emit `{ text }` without a `tone` key for normal lines:
```ts
import type { Layout, LogLine } from "@zarg/view"

/** An RLM's view: its status, its task and current cell, its history. */
export const RLM_LAYOUT: Layout = {
  name: "rlm",
  sections: [
    { id: "status", kind: "stats", role: "summary" },
    { id: "task", kind: "text", role: "primary", title: "Task" },
    { id: "history", kind: "log", role: "log", title: "History" },
  ],
}

const HISTORY_CODE_LINES = 8
const HISTORY_OUTPUT_LINES = 6
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const firstLines = (text: string, n: number) => {
  const all = text.split("\n")
  return all.length > n ? [...all.slice(0, n), `… ${all.length - n} more lines`] : all
}
const line = (text: string, tone?: "dim" | "error" | "accent"): LogLine => (tone === undefined ? { text } : { text, tone })

/** One transcript record as history lines. */
export const rlmLines = (l: Record<string, any>): ReadonlyArray<LogLine> => {
  switch (l.type) {
    case "start":
      return [line(`${l.preset} ${l.rlm}: ${String(l.task ?? "").split("\n")[0]}`)]
    case "model":
      return [line(`turn ${l.turn} · model ${(Number(l.modelMs) / 1000).toFixed(1)}s · ${Number(l.promptTokens).toLocaleString("en-US")} → ${Number(l.completionTokens).toLocaleString("en-US")} tokens`, "accent")]
    case "call": {
      const head = `  ${l.service}.${l.method} ${clip(JSON.stringify(l.params), 120)}  ${l.ms}ms`
      return [l.ok ? line(head, "dim") : line(`${head}  failed: ${l.failure?._tag}: ${clip(String(l.failure?.message ?? ""), 120)}`, "error")]
    }
    case "step":
      return [
        ...(String(l.text ?? "").trim().length > 0 ? [line(`  ${clip(String(l.text).trim().replaceAll("\n", " "), 300)}`)] : []),
        ...(l.cells ?? []).flatMap((c: { code: string; ok: boolean; output: string; ms: number }) => [
          line(`  cell ${c.ok ? "ok" : "failed"} ${c.ms}ms`, c.ok ? "dim" : "error"),
          ...firstLines(c.code, HISTORY_CODE_LINES).map((t) => line(`    │ ${t}`, "dim")),
          ...firstLines(c.output, HISTORY_OUTPUT_LINES).filter((t) => t.length > 0).map((t) => line(`    → ${t}`, c.ok ? undefined : "error")),
        ]),
      ]
    case "atomize":
      return [line(l.atomic ? "atomic (runs directly)" : "plan (splits into children)", "accent")]
    case "plan":
      return [line(`plan: ${(l.children ?? []).map((c: { id: string; preset: string }) => `${c.id} (${c.preset})`).join(", ")}`, "accent")]
    case "extend":
      return [line(`${(l.extended ? `extended to ${l.turns} turns` : "told to wrap up").padEnd(15)}  ${Number(l.confidence).toFixed(2)}  ${l.reason}`, "accent")]
    default:
      return []
  }
}
```

In `activity.ts`: add the parameter `views?: ViewStore` to `makeActivity`. Keep a per-RLM `{ task: string; code?: string; turns: number; budget: number; tokens?: number; status: string; preset: string }`. At each place the function writes a transcript record, also push:
```ts
    const push = (rlm: string, record: Record<string, unknown>) => {
      if (views === undefined || !views.has(rlm)) return
      const lines = rlmLines(record)
      if (lines.length > 0) views.append(rlm, "history", lines)
    }
    const status = (rlm: string, s: { preset: string; turns: number; budget: number; tokens?: number; status: string }) =>
      views?.has(rlm) && views.set(rlm, "status", { items: [{ label: "turns", value: `${s.turns}/${s.budget}` }, { label: "tokens", value: (s.tokens ?? 0).toLocaleString("en-US") }, { label: "preset", value: s.preset }, { label: "state", value: s.status, tone: s.status === "failed" ? "error" : s.status === "done" ? "ok" : "normal" }], progress: { done: s.turns, total: s.budget } })
```
- On `start`: `views?.start(id, RLM_LAYOUT)`, `views?.set(id, "task", { markdown: log.redact(e.task) })`, `status(...)`, then `push(id, { type: "start", rlm: id, preset: e.preset, task: e.task })`.
- On `step`: `push(id, { type, ...rest })`; if the step has cells, set `task` to `` `${task}\n\n\`\`\`ts\n${lastCell.code}\n\`\`\`` `` (redacted).
- On `model`, `record` (the record's `{ type: kind, … }` object), `atomize`, `extend`, `plan`: `push(id, <the record written to the transcript>)` (for `plan`, `{ type: "plan", children: e.children }`).
- On `turn` and `end`: `status(id, next)` with the node's new turns, tokens and status.

In `thread.ts:163` pass the thread's store: `makeActivity(log, threadId, undefined, threadViews(log, threadId))`. In `reconcile.ts:39`: `makeActivity(deps.log, "plan", undefined, threadViews(deps.log, "plan"))` and the same for `"implement"`. `plugin-agents.ts` keeps calling `makeActivity` without views (plugin agents draw their own).

- [ ] **Step 4: Run the tests**

Run: `mise //packages/core:typecheck && mise //packages/core:test`
Expected: PASS (all core tests; existing activity and thread tests unchanged).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add -A packages/core
git commit -m "feat(core): the RLM draws its view: status, task and cell, history"
```

---

### Task 7: The client keeps views; actions name their section

**Files:**
- Modify: `packages/client/src/state.ts`, `packages/client/src/client.ts`, `packages/client/src/session.ts`, `packages/client/package.json`
- Modify: `packages/core/src/server.ts` (the actions route accepts `section`), `packages/core/src/bodies.ts` (`act` passes `section`)
- Test: `packages/client/test/state.test.ts` (or the file holding `reduce` tests; find it with `grep -l "reduce(" packages/client/test`), `packages/client/test/client.test.ts`, `packages/core/test/server.test.ts`, `packages/core/test/bodies.test.ts`

**Interfaces:**
- Consumes: `reduceView`, `isViewEvent`, `Views` (Task 3).
- Produces: `ThreadState.views?: Views`; `Client.act(threadId, agent, action, section, rows)`; `Session.act(agent, action, section, rows)`; `POST /threads/:id/agents/:agent/actions/:action` body `{ section?: string, rows: string[] }`; plugin `act` params `{ agent, action, section, rows }`.

- [ ] **Step 1: Write the failing tests**

In the client reducer test file add:
```ts
test("view activities build the thread's views; they never touch the agents tree", () => {
  const layout = { name: "tester", sections: [{ id: "steps", kind: "log", role: "log" }] }
  let s = initial("main")
  s = reduce(s, { type: "ACTIVITY_SNAPSHOT", threadId: "main", seq: 1, messageId: "main:view:rehearse:t-1", activityType: "zarg.view", content: { agent: "rehearse:t-1", layout, data: {} } } as never)
  s = reduce(s, { type: "ACTIVITY_DELTA", threadId: "main", seq: 2, messageId: "main:view:rehearse:t-1", activityType: "zarg.view", content: { agent: "rehearse:t-1" }, patch: [{ op: "add", path: "/data/steps/lines/-", value: { text: "ok" } }] } as never)
  expect(s.views?.["rehearse:t-1"]?.data).toEqual({ steps: { lines: [{ text: "ok" }] } })
  expect(s.rlms).toEqual({})
})

test("replaying a view's events gives the view the core holds", () => {
  const layout = { name: "tester", sections: [{ id: "steps", kind: "log", role: "log" }, { id: "progress", kind: "stats", role: "summary" }] }
  const events = [
    { type: "ACTIVITY_SNAPSHOT", threadId: "main", seq: 1, messageId: "m", activityType: "zarg.view", content: { agent: "a", layout, data: {} } },
    ...Array.from({ length: 300 }, (_, i) => ({ type: "ACTIVITY_DELTA", threadId: "main", seq: i + 2, messageId: "m", activityType: "zarg.view", content: { agent: "a" }, patch: [{ op: "add", path: "/data/steps/lines/-", value: { text: String(i) } }, { op: "replace", path: "/data/progress", value: { items: [{ label: "n", value: String(i) }] } }] })),
  ]
  const live = events.reduce((s, e) => reduce(s, e as never), initial("main"))
  // A client attaching late gets the same events again (seq order); a reconnect replays some twice.
  const late = [...events, ...events.slice(100)].reduce((s, e) => reduce(s, e as never), initial("main"))
  expect(late.views).toEqual(live.views)
  expect((live.views!.a!.data.steps as { lines: unknown[] }).lines).toHaveLength(300)
})
```
In `client.test.ts` change the act test to send and expect `{ section: "review.findings", rows: ["R-1"] }`; in `server.test.ts` change the actions test to post `{ section: "review.findings", rows: ["R-1"] }` and expect the fake `Bodies.act` to receive the section; in `bodies.test.ts` expect `invoke("rehearse", "act", { agent: "tester-1", action: "apply", section: "review.findings", rows: ["R-1"] })`.

- [ ] **Step 2: Run to see them fail**

Run: `mise //packages/client:test && cd packages/core && mise x -- bun test test/server.test.ts test/bodies.test.ts`
Expected: FAIL: `views` undefined; act payloads lack `section`.

- [ ] **Step 3: Implement**

From `packages/client`: `mise x -- bun add @zarg/view@workspace:*`.
`state.ts`: `import { isViewEvent, reduceView, type Views } from "@zarg/view"`; add `readonly views?: Views` to `ThreadState` (doc: "Each agent's view (zarg.view activities), by agent id."); at the top of `reduce`, after the seq check:
```ts
  if (isViewEvent(e as never)) return { ...t, views: reduceView(t.views ?? {}, e as never) }
```
(before the `switch`, so view activities never reach the RLM tree cases).
`client.ts` `act(threadId, agent, action, section: string | undefined, rows)` posts `JSON.stringify({ ...(section !== undefined ? { section } : {}), rows })`.
`session.ts` `act: (agent, action, section, rows)` passes it through (type `(agent: string, action: string, section: string | undefined, rows: ReadonlyArray<string>) => Promise<void>`).
`server.ts` actions route: parse `{ section?: unknown; rows?: unknown }`; `section` must be a string when present (else 400 `an action's "section" must be a string`); call `bodies.act(thread, agent, action, section, rows)`.
`bodies.ts` `act(thread, agent, action, section: string | undefined, rows)` invokes `act` with `{ agent: o.id, action, ...(section !== undefined ? { section } : {}), rows }`; the `onApply` record is unchanged.
The TUI (`packages/view-tui/src/app.tsx`) passes `undefined` for the section for now (Task 8 replaces this).

- [ ] **Step 4: Run the tests**

Run: `mise run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/client packages/core packages/view-tui bun.lock
git commit -m "feat(client): threads keep their agents' views; actions name their section"
```

---

### Task 8: The terminal draws views

**Files:**
- Create: `packages/view-tui/src/sections.tsx`, `packages/view-tui/src/view-keys.ts`
- Modify: `packages/view-tui/src/app.tsx`, `packages/view-tui/src/view.ts`, `packages/view-tui/package.json` (dep `@zarg/view`)
- Test: `packages/view-tui/test/sections.test.tsx`, `packages/view-tui/test/view.test.ts` (key handling)

**Interfaces:**
- Consumes: `ViewState`, `ViewUi`, `initialViewUi`, `ordered`, `leafOf`, `rowsOf`, `focusNext`, `nextTab`, `moveRow`, `toggleSelect`, `actionFor`, `afterAction` (Task 3); `SessionState.thread.views` (Task 7); `Session.act(agent, action, section, rows)`.
- Produces:
  - `sections.tsx`: `TONES: Record<Tone, string>` (terminal colours), `renderers: Record<SectionKind, (p: SectionProps) => JSX.Element>`, `AgentView(props: { view: ViewState; ui: ViewUi; height: number })` stacking by role with per-role height caps.
  - `view-keys.ts`: `viewKeys(view: ViewState, ui: ViewUi, key: Key): { ui: ViewUi; act?: { section: string; action: string; rows: ReadonlyArray<string> } }`.
  - `view.ts`: `Ui.view?: ViewUi` replaces `Ui.body`; `onKey(ui, s, key, now, draft?)` (no `body` argument) routes keys in an open agent to `viewKeys` using `s.thread.views?.[ui.viewing]`; `Action` `act` gains `section`.

- [ ] **Step 1: Write the failing tests**

`packages/view-tui/test/sections.test.tsx`:
```tsx
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { defineView, initialViewUi, layoutOf, type ViewState } from "@zarg/view"
import { AgentView } from "../src/sections"

const tester = layoutOf(
  defineView("tester", {
    progress: { kind: "stats", role: "summary" },
    workers: { kind: "list", role: "primary", title: "Workers" },
    steps: { kind: "log", role: "log", title: "Steps" },
    review: {
      kind: "tabs",
      role: "pinned",
      tabs: {
        findings: { kind: "table", title: "Findings", columns: [{ id: "id", label: "id" }, { id: "note", label: "note" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] },
        likes: { kind: "table", title: "Likes", columns: [{ id: "id", label: "id" }] },
      },
    },
  }),
)
const view = (findings: number): ViewState => ({
  agent: "rehearse:tester-1",
  layout: tester,
  data: {
    progress: { items: [{ label: "steps", value: "14/22" }, { label: "flagged", value: "3" }], progress: { done: 14, total: 22 } },
    workers: { items: [{ id: "s3", text: "story 3  UX-0001 ▸ [UX-0012]", detail: "screening", state: "busy" }, { id: "s5", text: "story 5", detail: "waits for story 3 at UX-0012", state: "waiting" }] },
    steps: { lines: Array.from({ length: 40 }, (_, i) => ({ text: `step ${i}` })) },
    "review.findings": { rows: Array.from({ length: findings }, (_, i) => ({ id: `R-${i}`, cells: { id: `R-${i}`, note: `note ${i}` } })) },
    "review.likes": { rows: [] },
  },
})

let destroy: (() => void) | undefined
afterEach(() => destroy?.())
const frame = async (v: ViewState, ui = initialViewUi, size = { width: 100, height: 30 }) => {
  const t = await testRender(<AgentView view={v} ui={ui} height={size.height} />, { ...size, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  return t.captureCharFrame()
}

describe("the terminal draws an agent's view", () => {
  test("summary on top, then workers and steps, the review tables pinned at the bottom", async () => {
    const f = await frame(view(3))
    const lines = f.split("\n")
    const at = (s: string) => lines.findIndex((l) => l.includes(s))
    expect(at("14/22")).toBeLessThan(at("Workers"))
    expect(at("Workers")).toBeLessThan(at("Steps"))
    expect(at("Steps")).toBeLessThan(at("Findings"))
    expect(f).toContain("story 3")
    expect(f).toContain("R-2")
    expect(f).toContain("a Apply")
    // The log shows its newest lines (it follows the bottom).
    expect(f).toContain("step 39")
  })

  test("at 80×20 every section keeps its title and the pinned table stays within 40%", async () => {
    const f = await frame(view(30), initialViewUi, { width: 80, height: 20 })
    for (const t of ["Workers", "Steps", "Findings"]) expect(f).toContain(t)
    const lines = f.split("\n")
    const pinnedFrom = lines.findIndex((l) => l.includes("Findings"))
    expect(lines.length - pinnedFrom).toBeLessThanOrEqual(Math.ceil(20 * 0.4) + 1)
  })

  test("the focused section is marked, the highlighted row shows, selected rows are ticked", async () => {
    const f = await frame(view(3), { ...initialViewUi, focus: 3, rows: { "review.findings": 1 }, selected: { "review.findings": ["R-2"] } })
    expect(f).toContain("▸ [ ] R-1")
    expect(f).toContain("  [x] R-2")
  })
})
```
In `packages/view-tui/test/view.test.ts` replace the body-key tests (they use `bodyView` and a `Body`) with view-key tests:
```ts
describe("keys in an agent's view", () => {
  const layout = layoutOf(defineView("t", { steps: { kind: "log", role: "log" }, review: { kind: "tabs", role: "pinned", tabs: { findings: { kind: "table", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] }, likes: { kind: "table", columns: [] } } } }))
  const views = { "rehearse:t-1": { agent: "rehearse:t-1", layout, data: { "review.findings": { rows: [{ id: "R-1", cells: {} }, { id: "R-2", cells: {} }] } } } }
  const s = { ...base, thread: { ...base.thread, views } } as SessionState
  const open = { ...initialUi, viewing: "rehearse:t-1" }
  test("Tab moves focus between sections, [ and ] switch tabs, space and a apply the selected rows", () => {
    let ui = onKey(open, s, { name: "tab" }, 0).ui
    expect(ui.view?.focus).toBe(1)
    ui = onKey(ui, s, { name: "down" }, 0).ui
    ui = onKey(ui, s, { name: "space" }, 0).ui
    const r = onKey(ui, s, { name: "a" }, 0)
    expect(r.action).toEqual({ type: "act", section: "review.findings", action: "apply", rows: ["R-2"] })
    expect(r.ui.view?.selected["review.findings"]).toEqual([])
    expect(onKey(ui, s, { name: "]" }, 0).ui.view?.tabs.review).toBe(1)
  })
  test("Escape goes back to the conversation", () => {
    expect(onKey(open, s, { name: "escape" }, 0).ui.viewing).toBeUndefined()
  })
})
```
(`base` is the test file's existing base `SessionState`; if it has another name, use that. Import `defineView`, `layoutOf` from `@zarg/view`.)

- [ ] **Step 2: Run to see them fail**

Run: `mise //packages/view-tui:test`
Expected: FAIL: `../src/sections` missing; `onKey` has no view handling.

- [ ] **Step 3: Implement `view-keys.ts`**

```ts
import { actionFor, afterAction, focusNext, moveRow, nextTab, toggleSelect, type ViewState, type ViewUi } from "@zarg/view"

/** A key in an open agent's view: focus, scroll a table's cursor, switch tabs, select, act. */
export const viewKeys = (view: ViewState, ui: ViewUi, key: { readonly name: string; readonly shift?: boolean }): { readonly ui: ViewUi; readonly act?: { readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string> } } => {
  if (key.name === "tab") return { ui: focusNext(view, ui, key.shift === true ? -1 : 1) }
  if (key.name === "]") return { ui: nextTab(view, ui, 1) }
  if (key.name === "[") return { ui: nextTab(view, ui, -1) }
  if (key.name === "down") return { ui: moveRow(view, ui, 1) }
  if (key.name === "up") return { ui: moveRow(view, ui, -1) }
  if (key.name === "pagedown") return { ui: moveRow(view, ui, 10) }
  if (key.name === "pageup") return { ui: moveRow(view, ui, -10) }
  if (key.name === "space") return { ui: toggleSelect(view, ui) }
  const a = actionFor(view, ui, key.name)
  return a === undefined ? { ui } : { ui: afterAction(ui, a.section), act: a }
}
```

- [ ] **Step 4: Implement `sections.tsx`**

```tsx
import type { ReactNode } from "react"
import { leafOf, ordered, rowsOf, type LayoutLeaf, type LayoutSection, type SectionKind, type ViewState, type ViewUi } from "@zarg/view"

/** The terminal's colour for each tone. */
export const TONES = { normal: "#e8eaed", ok: "#81c995", warn: "#fdd663", error: "#f28b82", dim: "#9aa0a6", accent: "#81c995" } as const
const SELECT_BG = "#3c4043"
type Tone = keyof typeof TONES
const fg = (t: unknown) => TONES[(t as Tone) ?? "normal"] ?? TONES.normal
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
const bar = (done: number, total: number, w = 24) => "█".repeat(total > 0 ? Math.round((done / total) * w) : 0).padEnd(w, "░")
const STATE_MARK = { busy: "●", waiting: "◌", done: "✓", flagged: "⚑" } as const

interface LeafProps { readonly view: ViewState; readonly ui: ViewUi; readonly path: string; readonly leaf: LayoutLeaf; readonly focused: boolean }
type Leaf = (p: LeafProps) => ReactNode

const Stats: Leaf = ({ view, path }) => {
  const d = view.data[path] as { items?: ReadonlyArray<{ label: string; value: string; tone?: string }>; progress?: { done: number; total: number } } | undefined
  const items = (d?.items ?? []).map((i) => `${i.value} ${i.label}`).join("   ")
  return <text fg={TONES.normal} wrapMode="none">{`${d?.progress !== undefined ? `${bar(d.progress.done, d.progress.total)}  ` : ""}${items}`}</text>
}
const List: Leaf = ({ view, ui, path, focused }) => {
  const items = (view.data[path] as { items?: ReadonlyArray<{ id: string; text: string; detail?: string; state?: keyof typeof STATE_MARK; tone?: string }> } | undefined)?.items ?? []
  const row = ui.rows[path] ?? 0
  return (
    <>
      {items.map((it, i) => (
        <text key={it.id} wrapMode="none" fg={it.state === "waiting" || it.state === "done" ? TONES.dim : it.state === "flagged" ? TONES.warn : fg(it.tone)} {...(focused && i === row ? { bg: SELECT_BG } : {})}>
          {`${it.state !== undefined ? STATE_MARK[it.state] : " "} ${pad(it.text, 56)} ${it.detail ?? ""}`}
        </text>
      ))}
    </>
  )
}
const Log: Leaf = ({ view, path }) => (
  <>
    {((view.data[path] as { lines?: ReadonlyArray<{ text: string; tone?: string }> } | undefined)?.lines ?? []).map((l, i) => (
      <text key={i} fg={fg(l.tone)} wrapMode="none">{l.text}</text>
    ))}
  </>
)
const Table: Leaf = ({ view, ui, path, leaf, focused }) => {
  const cols = leaf.columns ?? []
  const rows = (view.data[path] as { rows?: ReadonlyArray<{ id: string; cells: Record<string, string>; tone?: string }> } | undefined)?.rows ?? []
  const widths = cols.map((c, ci) => (ci === cols.length - 1 ? 0 : Math.min(24, Math.max(c.label.length, ...rows.map((r) => (r.cells[c.id] ?? "").length)))))
  const cells = (get: (c: { id: string; label: string }) => string) => cols.map((c, ci) => (widths[ci] === 0 ? get(c) : pad(get(c), widths[ci]!))).join("  ")
  const cursor = ui.rows[path] ?? 0
  const sel = ui.selected[path] ?? []
  const box = leaf.selectable === true ? 4 : 0
  return (
    <>
      <text fg={TONES.dim} wrapMode="none">{`  ${" ".repeat(box)}${cells((c) => c.label)}`}</text>
      {rows.length === 0 ? <text fg={TONES.dim}>  (none)</text> : null}
      {rows.map((r, i) => (
        <text key={r.id} wrapMode="none" fg={focused && i === cursor ? TONES.accent : fg(r.tone)} {...(focused && i === cursor ? { bg: SELECT_BG } : {})}>
          {`${focused && i === cursor ? "▸" : " "} ${leaf.selectable === true ? `[${sel.includes(r.id) ? "x" : " "}] ` : ""}${cells((c) => r.cells[c.id] ?? "")}`}
        </text>
      ))}
      {(leaf.actions ?? []).length > 0 ? (
        <text fg={TONES.dim} wrapMode="none">{["↑↓ move", ...(leaf.selectable === true ? ["space select"] : []), ...(leaf.actions ?? []).map((a) => `${a.key ?? "?"} ${a.label}`)].join(" · ")}</text>
      ) : null}
    </>
  )
}
const KeyValue: Leaf = ({ view, path }) => (
  <>
    {((view.data[path] as { pairs?: ReadonlyArray<{ key: string; value: string }> } | undefined)?.pairs ?? []).map((p) => (
      <text key={p.key} wrapMode="none">{`${pad(p.key, 14)} ${p.value}`}</text>
    ))}
  </>
)
const Text: Leaf = ({ view, path }) => <text fg={TONES.normal}>{(view.data[path] as { markdown?: string } | undefined)?.markdown ?? ""}</text>

/** How the terminal draws each leaf kind; tabs draw their current leaf. Every kind must be here. */
export const renderers: Record<Exclude<SectionKind, "tabs">, Leaf> = { stats: Stats, list: List, log: Log, table: Table, keyvalue: KeyValue, text: Text }

const count = (view: ViewState, path: string) => rowsOf(view, path).length
const titleOf = (view: ViewState, ui: ViewUi, s: LayoutSection) =>
  s.kind === "tabs"
    ? s.tabs.map((t, i) => { const label = `${t.title ?? t.id} (${count(view, `${s.id}.${t.id}`)})`; return i === (ui.tabs[s.id] ?? 0) ? `[${label}]` : label }).join("  ")
    : s.title ?? ""

/** Heights by role: summary fits its content, primary up to a third, pinned up to 40%, log takes the rest. */
const heightOf = (view: ViewState, ui: ViewUi, s: LayoutSection, total: number): number | undefined => {
  const leaf = leafOf(view, ui, s.id)
  const content = leaf === undefined ? 1 : leaf.leaf.kind === "stats" || leaf.leaf.kind === "text" ? 1 : rowsOf(view, leaf.path).length + (leaf.leaf.kind === "table" ? 2 + ((leaf.leaf.actions ?? []).length > 0 ? 1 : 0) : 0)
  const framed = content + 2
  if (s.role === "summary") return s.kind === "stats" ? 1 : Math.min(framed, 6)
  if (s.role === "primary") return Math.max(3, Math.min(framed, Math.floor(total / 3)))
  if (s.role === "pinned") return Math.max(3, Math.min(framed, Math.floor(total * 0.4)))
  if (s.role === "aside") return Math.max(3, Math.min(framed, Math.floor(total / 4)))
  return undefined
}

/** An agent's view in the terminal: its sections stacked by role, each in its own scrollbox. */
export const AgentView = (props: { readonly view: ViewState; readonly ui: ViewUi; readonly height: number }) => {
  const all = ordered(props.view.layout)
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      {all.map((s, i) => {
        const leaf = leafOf(props.view, props.ui, s.id)
        if (leaf === undefined) return null
        const Draw = renderers[leaf.leaf.kind]
        const focused = props.ui.focus === i
        const h = heightOf(props.view, props.ui, s, props.height)
        if (s.role === "summary" && s.kind === "stats")
          return (
            <box key={s.id} style={{ flexShrink: 0, height: 1, paddingLeft: 1 }}>
              <Draw view={props.view} ui={props.ui} path={leaf.path} leaf={leaf.leaf} focused={focused} />
            </box>
          )
        return (
          <scrollbox
            key={s.id}
            title={titleOf(props.view, props.ui, s)}
            style={{ border: true, borderColor: focused ? TONES.accent : TONES.dim, paddingLeft: 1, ...(h === undefined ? { flexGrow: 1, minHeight: 3 } : { height: h, flexShrink: 0 }) }}
            {...(leaf.leaf.kind === "log" ? { stickyScroll: true, stickyStart: "bottom" as const } : {})}
          >
            <Draw view={props.view} ui={props.ui} path={leaf.path} leaf={leaf.leaf} focused={focused} />
          </scrollbox>
        )
      })}
    </box>
  )
}
```
Keep the focused table's cursor row visible: give each row `id={\`row-${path}-${r.id}\`}` and, in `AgentView`, a `useEffect` on `[focus, rows]` that calls the scrollbox ref's `scrollChildIntoView` (the agents pane in `app.tsx` does the same; copy its pattern).

- [ ] **Step 5: Wire it into the shell**

From `packages/view-tui`: `mise x -- bun add @zarg/view@workspace:*`.
`view.ts`:
- Replace `body?: BodyUi` with `view?: ViewUi` in `Ui`; delete `BodyUi`, `tabsOf`, `bodyView` and `bodyKeys`; keep `historyView` only if something still uses it (after Task 6 nothing does: delete it and its tests, the core's `rlmLines` replaced it).
- `openHistory` resets `view` (`const { view: _, ...rest } = ui`).
- `Action` `act` becomes `{ type: "act"; section: string; action: string; rows: ReadonlyArray<string> }`.
- `onKey(ui, s, key, now, draft?)`: in the `ui.viewing !== undefined` branch, when no question is pending:
```ts
    const v = s.thread.views?.[ui.viewing]
    if (v === undefined) return { ui }
    const r = viewKeys(v, ui.view ?? initialViewUi, key)
    return { ui: { ...ui, view: r.ui }, ...(r.act !== undefined ? { action: { type: "act", ...r.act } } : {}) }
```
(`Key` must carry `shift`: add `readonly shift?: boolean` and pass `key.shift` from `useKeyboard`).
`app.tsx`:
- Delete the body state, `bodyRef`, `reloadBody`, `HISTORY_REFRESH_MS` and the polling `useEffect`.
- `act`: `props.session.act(agent, action.action, action.section, action.rows)`.
- The viewing branch renders:
```tsx
        {viewing !== undefined ? (
          <box title={`${viewing} · Esc back`} style={{ flexGrow: 1, border: true, borderColor: COLORS.accent }}>
            {s.thread.views?.[viewing] === undefined ? <text fg={COLORS.dim}>no view yet</text> : <AgentView view={s.thread.views[viewing]!} ui={ui.view ?? initialViewUi} height={dims.height - 3} />}
          </box>
        ) : ( …conversation… )}
```
with `const dims = useTerminalDimensions()` from `@opentui/react`.
- The status hint while viewing: `"Tab sections · [ ] tabs · ↑↓ move · Space select · Esc back"`.
Update `app.test.tsx` cases that opened an agent's body: they now put a view in `thread.views` and expect `AgentView` output; regenerate the snapshot only after reading the diff (`mise x -- bun test --update-snapshots` in `packages/view-tui`), and ledger why each snapshot line changed.

- [ ] **Step 6: Run the tests**

Run: `mise //packages/view-tui:typecheck && mise //packages/view-tui:test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
mise run verify
git add -A packages/view-tui bun.lock
git commit -m "feat(tui): agents' views drawn by role, each section scrolling on its own"
```

---

### Task 9: Rehearse draws the tester and run views; bodies go

**Files:**
- Create: `packages/plugin-rehearse/src/views.ts`
- Modify: `packages/plugin-rehearse/src/run.ts`, `packages/plugin-rehearse/src/index.ts`, `packages/plugin-rehearse/test/run.test.ts`, `packages/plugin-rehearse/test/plugin.test.ts`
- Delete: `packages/core/src/bodies.ts` → replaced by `packages/core/src/actions.ts`; `packages/core/test/bodies.test.ts` → `packages/core/test/actions.test.ts`
- Modify: `packages/core/src/server.ts` (drop `GET …/body`, `Bodies` → `Actions`), `packages/core/src/live.ts`, `packages/core/src/index.ts`, `packages/client/src/client.ts` (drop `body`), `packages/client/src/session.ts` (drop `body`), `packages/client/src/state.ts` (drop `Body`, `BodyPart`), their tests; `packages/plugin/src/server/host.ts` (`RESERVED` drops `body`)
- Modify: `AGENTS.md`; delete `packages/cli/mockups/`

**Interfaces:**
- Consumes: `defineView`, `Views` (Task 4), `pluginAgents` view events (Task 5), `act` with `section` (Task 7).
- Produces: `TesterView`, `RunView`, `FINDING_COLUMNS`; `RunDeps.views: { set(agent, view, path, data); append(agent, view, path, lines) }` (the SDK `Views` shape); plugin `act({ agent, action, section, rows })`; `makeActions({ invoke, onApply })` with `act(thread, agent, action, section, rows)`.

- [ ] **Step 1: Write the failing tests**

In `packages/plugin-rehearse/test/run.test.ts`, give `setup` a fake `views` recording pushes:
```ts
    const pushes: Array<{ agent: string; path: string; data?: unknown; lines?: unknown }> = []
    // in deps:
      views: {
        set: (agent, _v, path, data) => Effect.sync(() => void pushes.push({ agent, path, data })),
        append: (agent, _v, path, lines) => Effect.sync(() => void pushes.push({ agent, path, lines })),
      },
```
return `pushes` from `setup`, and replace the two body tests with:
```ts
  test("the tester's view: workers follow the walk, steps are logged, its findings fill the review table", async () => {
    const t = await finish({ slowDecide: 3 })
    const workers = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "workers").map((p) => p.data as { items: ReadonlyArray<{ state?: string; detail?: string }> })
    expect(workers.some((w) => w.items.some((i) => i.state === "busy"))).toBe(true)
    // Both stories start with A, B: one screens the shared step, the other waits for it.
    expect(workers.some((w) => w.items.some((i) => i.state === "waiting"))).toBe(true)
    expect(workers.at(-1)!.items).toEqual([])
    expect(t.pushes.filter((p) => p.agent === "tester-1" && p.path === "steps").flatMap((p) => p.lines as ReadonlyArray<{ text: string }>).map((l) => l.text)).toContain("B: feel 1.00, fail 0.30 → flagged feel → 1 finding")
    const id = t.r.record(t.run)!.findings[0]!.id
    const review = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "review.findings").at(-1)!.data as { rows: ReadonlyArray<{ id: string }> }
    expect(review.rows.map((r) => r.id)).toEqual([id])
  })

  test("the run's view: progress over all testers, the report, every finding; apply refreshes it", async () => {
    const t = await finish()
    const id = t.r.record(t.run)!.findings[0]!.id
    expect(t.pushes.find((p) => p.agent === "run" && p.path === "report")?.data).toEqual({ markdown: "Testers stalled at B." })
    expect(await Effect.runPromise(t.r.act("apply", "review.findings", [id]))).toEqual({ notice: "1 finding sent to the driver" })
    const last = t.pushes.filter((p) => p.agent === "run" && p.path === "review.findings").at(-1)!.data as { rows: ReadonlyArray<{ cells: Record<string, string> }> }
    expect(last.rows[0]!.cells.note).toStartWith("✓ ")
  })
```
Update every other `t.r.act("apply", [id])` / `("dismiss", [..])` call in the file to `t.r.act("apply", "review.findings", [id])`. In `test/plugin.test.ts`, replace the `body` invocation with a check on the view events the host saw: collect `agents` events and expect a `{ event: "start", id: "tester-1", view: "tester" }` and at least one `{ event: "set", section: "review.findings" }` for `run` with a non-empty `rows`.
In `packages/core/test/actions.test.ts` (renamed from `bodies.test.ts`), keep only the action cases (the body cases go), calling `makeActions({ invoke, onApply })` and `act("main", "rehearse:tester-1", "apply", "review.findings", ["R-1"])`.

- [ ] **Step 2: Run to see them fail**

Run: `mise //packages/plugin-rehearse:test`
Expected: FAIL: `deps.views` unused, no workers pushed; `act` takes two arguments.

- [ ] **Step 3: Implement `views.ts`**

```ts
import { defineView } from "@zarg/plugin-sdk"

export const FINDING_COLUMNS = [
  { id: "id", label: "id" },
  { id: "kind", label: "kind" },
  { id: "card", label: "card" },
  { id: "severity", label: "severity" },
  { id: "suggested", label: "suggested" },
  { id: "note", label: "note" },
]
const ACTIONS = [
  { id: "apply", label: "Apply", key: "a", on: "selection" },
  { id: "dismiss", label: "Dismiss", key: "d", on: "selection" },
] as const
const review = {
  kind: "tabs",
  role: "pinned",
  tabs: {
    findings: { kind: "table", title: "Findings", columns: FINDING_COLUMNS, selectable: true, actions: ACTIONS },
    likes: { kind: "table", title: "Likes", columns: FINDING_COLUMNS, selectable: true, actions: ACTIONS },
  },
} as const

/** One tester: its walk (workers), what it checked (steps), its findings. */
export const TesterView = defineView("tester", {
  progress: { kind: "stats", role: "summary" },
  workers: { kind: "list", role: "primary", title: "Workers" },
  steps: { kind: "log", role: "log", title: "Steps" },
  review,
})

/** The whole run: progress over every tester, the report, every finding. */
export const RunView = defineView("run", {
  progress: { kind: "stats", role: "summary" },
  report: { kind: "text", role: "primary", title: "Report" },
  review,
})
```

- [ ] **Step 4: Implement in `run.ts`**

- `RunDeps` gains `readonly views: { readonly set: (agent: string, view: unknown, path: string, data: unknown) => Effect.Effect<void, unknown>; readonly append: (agent: string, view: unknown, path: string, lines: ReadonlyArray<{ text: string; tone?: string }>) => Effect.Effect<void, unknown> }` (the SDK `Views` is assignable to it).
- `agents.start` for the run passes `view: "run"`; for each tester `view: "tester"`.
- Workers per tester: keep `const inFlightStories = new Map<number, { story: number; path: string; state: "busy" | "waiting"; detail: string }>()` and a `const showWorkers = () => quiet(deps.views.set(id, TesterView, "workers", { items: [...inFlightStories.values()].map((w) => ({ id: `s${w.story}`, text: `story ${w.story}  ${w.path}`, detail: w.detail, state: w.state })) }))`. In the story loop (`Effect.forEach(rec.stories, (story, si) => …)`, add the index):
  - before `viewOf` of step `i`: set `{ story: si + 1, path: <cards up to i, the current one in brackets, joined with " ▸ ">, state: "busy", detail: "screening" }`, then `showWorkers()`;
  - when `waiting !== undefined`: set state `waiting`, detail `waits at ${step.card}`, `showWorkers()`, then await;
  - before `diagnose`: detail `diagnosing ${screened.flags.join(", ")}`;
  - when the story ends (after the loop): delete the entry and `showWorkers()`.
- Replace `deps.agents.step({ id, text: \`${step.card}: ${said}\` })` with `deps.views.append(id, TesterView, "steps", [{ text: \`${step.card}: ${said}\`, ...(screened?.flags.length ? { tone: "warn" } : {}) }])`, wrapped in `quiet`.
- In `progress(...)` also push `deps.views.set(id, TesterView, "progress", { items: [{ label: "steps", value: \`${checked.size}/${toCheck}\` }, { label: "flagged", value: String(flagged) }, { label: "unreachable", value: String(rec.unreachable) }], progress: { done: checked.size, total: toCheck } })` and the run's `progress` the same way over `allChecked / all`.
- After each diagnosis with findings: push this tester's diagnosed raw findings as rows of `review.findings` (id `persona|card|kind`, cells from the raw finding; `suggested` empty until triage).
- When the run is done (after `report`): `set("run", RunView, "report", { markdown: text })`, then `refresh()`.
- Add `const refresh = () => Effect.gen(function* () { … })` that, for the latest done run, pushes `review.findings` / `review.likes` rows (the same filtering the old `body` used: not dismissed, not resolved; delight → likes) to `run` and, per tester `tester-N`, only the findings whose `personas` include that tester's persona name. Cells: `{ id, kind, card, severity, suggested: \`${f.route} ${f.real.toFixed(2)}\`, note: \`${chosen(r, f) ? "✓ " : ""}${f.notes.join(" / ")}\` }`.
- `act(action, section, ids)`: same apply/dismiss logic as before, then `yield* refresh()`; `section` is accepted and ignored (both tables share the actions).
- `resolved(...)` also calls `refresh()`; `resume` calls `refresh()` once records are loaded.
- Delete `body`, `rowsOf`, the `BodyPart` type and `body` from the returned object.

`index.ts`: add `views: [TesterView, RunView]` to the plugin; yield `Views` in `make` and pass `views` into `makeRehearse`; drop the `body` method; `act` params become `Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) })` and the handler calls `r.act(action, section ?? "review.findings", rows)`.

- [ ] **Step 5: Remove bodies from the core, client and host**

- `packages/core/src/actions.ts`:
```ts
import { Effect } from "effect"

type Invoke = (plugin: string, method: string, params: unknown) => Effect.Effect<unknown, { readonly message: string }>

/** A plugin agent's id is `<plugin>:<id>`; an RLM's has no colon. */
const owner = (agent: string) => {
  const at = agent.indexOf(":")
  return at < 0 ? undefined : { plugin: agent.slice(0, at), id: agent.slice(at + 1) }
}

/** Actions on an agent's view go to its plugin's `act`; the core records what the operator applied (the findings gate). */
export const makeActions = (deps: { readonly invoke: Invoke; readonly onApply?: (plugin: string, rows: ReadonlyArray<string>) => void }) => ({
  act: (_thread: string, agent: string, action: string, section: string | undefined, rows: ReadonlyArray<string>): Effect.Effect<{ readonly notice: string }> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ notice: `${agent} has no actions` })
    return deps.invoke(o.plugin, "act", { agent: o.id, action, ...(section !== undefined ? { section } : {}), rows }).pipe(
      Effect.tap(() => Effect.sync(() => (action === "apply" ? deps.onApply?.(o.plugin, rows) : undefined))),
      Effect.map((r) => ({ notice: String((r as { notice?: unknown } | null)?.notice ?? "done") })),
      Effect.catch((e) => Effect.succeed({ notice: e.message })),
    )
  },
})
export type Actions = ReturnType<typeof makeActions>
```
- `server.ts`: rename the `Bodies` service to `Actions` with only `act`; delete the `GET /threads/:id/agents/:agent/body` route; update `live.ts` (`makeActions({ invoke, onApply: (plugin, rows) => chosen.add(plugin, rows) })`) and `index.ts` exports; `server.test.ts` provides `Actions` and drops the body route test (add one asserting `GET …/body` is 404).
- `git rm packages/core/src/bodies.ts` and move its remaining action tests to `test/actions.test.ts`.
- Client: delete `client.body`, `Session.body`, `Body`, `BodyPart` and their tests.
- Host: remove `"body"` from `RESERVED` in `packages/plugin/src/server/host.ts`.

- [ ] **Step 6: Docs and cleanup**

In `AGENTS.md`, under Packages, add after `packages/client`:
```
- `packages/view` (`@zarg/view`, `@zarg/view/react`): agent views, platform-free: the section schema and `defineView`, the AG-UI view reducer, the view behaviour (focus, tabs, rows, selection) and `useView`. Imports no platform module.
- `packages/view-tui` (`@zarg/view-tui`): the terminal platform: the TUI shell (conversation, agents pane, question picker) and a renderer for every section kind. Never imports `@zarg/core` or a `/server` subpath.
```
and in the `packages/plugin-sdk` line add `defineView` and `Views`. Delete the mockup: `rm -r packages/cli/mockups`.

- [ ] **Step 7: Run everything**

Run: `mise run -q build:plugins && mise run verify`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A packages AGENTS.md bun.lock
git commit -m "feat: rehearse draws its tester and run views; bodies are gone"
```

---

## Self-review notes

- Spec coverage: contract (Tasks 2, 4), data flow and persistence (5, 7), coalescing and log cap (5), redaction (5), RLM view (6), platform packages and portability (1, 2, 3), terminal renderer and keys (8), tester, run views and workers (9), removal of bodies and polling (8, 9), web independence test (3), gone plugin's view readable (views live in the core's thread log: Task 5; actions on a gone plugin answer a notice: kept in `makeActions`, test kept in Task 9's `actions.test.ts`).
- Tab badges: the spec lists `badge?` on tabs; the terminal shows each tab's row count in its title instead, so no `badge` field is added (nothing sets it). Ledger this if the executor agrees.
- Types used across tasks: `ViewState`, `ViewUi`, `Layout`, `LayoutSection`, `LayoutLeaf`, `SectionPath`, `LogPath`, `DataAt`, `ViewStore`, `makeViews`, `threadViews`, `DEFAULT_LAYOUT`, `RLM_LAYOUT`, `rlmLines`, `viewKeys`, `AgentView`, `renderers`, `TesterView`, `RunView`, `makeActions`: each defined once, in the task that produces it.
