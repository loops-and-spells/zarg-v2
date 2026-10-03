# Intents in the Graph (b): The Intent Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `intent` agent (a sandboxed first-party plugin, `packages/agent-intent`). It reconciles changed, new or uncovered outcomes and constraints, and unserving journeys, into small plans on the Backlog, each pinned to the statement it serves. It sends the inbox what it cannot decide.

**Architecture:** It follows triage's pattern. `makeIntent(deps)` is pure logic over plain-function deps, so tests stub it; `index.ts` wires those deps to the Gherkin and Backlog contracts and to the `Entities`, `Models`, `Inbox` and `Files` powers. A round reads one statement (or one unserving journey) with its journeys, their scenarios and their code. The driver model drafts gherkin tool calls per scenario, each round's draft is dry-run, and the round is folded with the shared `@zarg/fold` library (moved out of triage). Plans go to the Backlog lane with `serves: <statement ref@version>`. A checkpoint (`.zarg/intent/checkpoint.json`) records the statement versions already reconciled. The core wakes the agent when the graph directory changes.

**Tech Stack:** Bun, Effect 4, `@zarg/plugin-sdk`, `@zarg/fold` (new, no deps), bun test.

**Spec:** `docs/superpowers/specs/2026-10-02-intents-in-the-graph-design.md`. Depends on plan (a): `docs/superpowers/plans/2026-10-03-intents-model-view-migration.md` (it must be done first).

## Global Constraints

- `mise run build:plugins && mise run verify` passes before every commit.
- Run tools through mise (`mise x -- bun …`); never `npm`/`npx`/`node`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Only a plugin's `/contract` may be imported by another package (`packages/plugin/test/import-rule.test.ts`). Shared logic lives in a library package, never in a plugin package.
- Drafts never touch the graph: only the Planner applies a plan, after the operator moves it to Ready.
- The agent's model role is `driver`, with no reasoning by default (`[plugins.intent] reasoning = true` turns it on), as for triage.
- Ask before any live model run: GPU warm-ups, the router, smoke runs. Tests stub every model.
- Never start a zarg core in the repo root. Tests use temp dirs and never write `~/.config/zarg`.
- Words: outcome, constraint, question, statement, scenario, journey, plan; "the operator"; never goal or card.

## Review Focus

1. **A statement that changes while its round drafts.** Expected: the round files nothing. It doesn't checkpoint, and the next tick drafts it again against the new version. Task 3 tests it.
2. **A removed statement whose plans are still in Backlog.** Expected: those plans are dropped, and only Backlog-lane ones (a Ready or Running plan stays, since the operator already chose it). Its checkpoint entry goes too. Task 2 and Task 3 test it.
3. **The model is down, or answers no JSON.** Expected: one log line ("the driver model did not answer…"), nothing checkpointed, so the next wake tries again. No crash and no empty plan. Task 3 tests it.
4. **Ticks with nothing due.** Expected: no model call, no plan, no topic. That covers a fully checkpointed graph, an asked statement still waiting for its answer, and a graph without intents. Otherwise the graph watcher would spend tokens on every write. Task 3 tests it.
5. **An answer to an old question.** The inbox topic's statement changed or was removed after the topic went out. Expected: the answer is ignored with a notice, and the statement's next round starts fresh. Task 4 tests it.

---

## File Structure

- Create `packages/fold/` (`@zarg/fold`): `src/index.ts`, moved from `packages/agent-triage/src/fold.ts`, plus `jsonIn` from `agent-triage/src/triage.ts`; `package.json`; `mise.toml`; `tsconfig.json`; `test/fold.test.ts`, moved.
- Modify `packages/agent-triage/src/triage.ts` and `packages/agent-triage/package.json`: import from `@zarg/fold`.
- Modify `packages/plugin-backlog/src/contract.ts`: `PlanParams.serves`, and a `dropServing` contract method.
- Modify `packages/plugin-backlog/src/index.ts`: `plan` events say "Intent Agent" when `serves` is set; `dropServing`; the drawer and plan text show what a plan serves.
- Create `packages/agent-intent/`:
  - `src/intent.ts`: `makeIntent`, the rounds;
  - `src/checkpoint.ts`: the checkpoint shape and `due`;
  - `src/views.ts` and `src/view.ts`: the agent's view;
  - `src/index.ts`: the plugin;
  - `package.json`, `mise.toml`, `tsconfig.json`;
  - `test/checkpoint.test.ts`, `test/intent.test.ts`, `test/plugin.test.ts`.
- Modify `packages/plugin/scripts/build-plugins.ts`: `FIRST_PARTY` gains `agent-intent`.
- Create `packages/core/src/graph-watch.ts`; modify `packages/core/src/live.ts`: wake the intent agent.
- Modify `packages/plugin-gherkin/src/intents.ts` and `src/index.ts`: the Intents view lists plans in flight per statement.
- Modify `packages/audit/src/index.ts`: `uncovered` and `unserving` become problems (Task 7, only once the graph has none).
- Docs: `AGENTS.md`, `docs/taxonomy.md`.

---

### Task 1: `@zarg/fold` — the fold, shared by triage and intent

**Files:**
- Create: `packages/fold/package.json`, `packages/fold/mise.toml`, `packages/fold/tsconfig.json`, `packages/fold/src/index.ts`
- Move: `packages/agent-triage/src/fold.ts` → `packages/fold/src/index.ts`; `packages/agent-triage/test/fold.test.ts` → `packages/fold/test/fold.test.ts`
- Modify: `packages/agent-triage/src/triage.ts:1-3,74-84`, `packages/agent-triage/package.json`, and any agent-triage test importing `../src/fold`

**Interfaces:**
- Produces from `@zarg/fold`: `Unit`, `Group`, `Folded`, `CAP`, `ATOMIC`, `dependencies`, `fold` and `merge` (unchanged), and `jsonIn(text: string): unknown` (moved from triage).

- [ ] **Step 1: Move the files and create the package**

```bash
mkdir -p packages/fold/src packages/fold/test
git mv packages/agent-triage/src/fold.ts packages/fold/src/index.ts
git mv packages/agent-triage/test/fold.test.ts packages/fold/test/fold.test.ts
cp packages/agent-triage/tsconfig.json packages/fold/tsconfig.json
cp packages/agent-triage/mise.toml packages/fold/mise.toml
cat > packages/fold/package.json <<'EOF'
{
  "name": "@zarg/fold",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  }
}
EOF
```
In `packages/fold/test/fold.test.ts`, change the import to `from "../src/index"`.

- [ ] **Step 2: Move `jsonIn` and its test**

Cut `jsonIn` (its doc comment and body) from `packages/agent-triage/src/triage.ts` and append it to `packages/fold/src/index.ts`. Find triage's `jsonIn` test, if there is one: `grep -n "jsonIn" packages/agent-triage/test/*.ts`. Move it to `packages/fold/test/fold.test.ts` and import `jsonIn` from `../src/index`. If there is none, add this one:
```ts
test("jsonIn: the first JSON object, fenced or among words; undefined without one", () => {
  expect(jsonIn('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
  expect(jsonIn('ok {"b":2} done')).toEqual({ b: 2 })
  expect(jsonIn("no json")).toBeUndefined()
})
```

- [ ] **Step 3: Point triage at the library**

In `packages/agent-triage/src/triage.ts`, replace `import { ATOMIC, CAP, dependencies, fold, type Folded, type Group, merge, type Unit } from "./fold"` with `import { ATOMIC, CAP, dependencies, fold, type Folded, type Group, jsonIn, merge, type Unit } from "@zarg/fold"`. Keep `export { jsonIn }` from triage.ts only if a test imports it from there. Check with `grep -rn "jsonIn" packages/agent-triage/test`; otherwise switch those tests' imports to `@zarg/fold`.
```bash
cd packages/agent-triage && mise x -- bun add @zarg/fold@workspace:* && cd ../.. && mise x -- bun install
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/fold && mise x -- bun test && mise x -- bunx tsc --noEmit -p . && cd ../agent-triage && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS. The fold tests are unchanged; triage's tests still pass.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add -A packages/fold packages/agent-triage bun.lock && git commit -m "refactor: the fold is a library (@zarg/fold), for triage and the intent agent

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backlog plans say what statement they serve

**Files:**
- Modify: `packages/plugin-backlog/src/contract.ts` (`PlanParams`, the `Backlog` contract)
- Modify: `packages/plugin-backlog/src/items.ts` (`Item.serves`)
- Modify: `packages/plugin-backlog/src/index.ts` (`plan`, `dropServing`, the method list, the drawer)
- Modify: `packages/plugin-backlog/src/plan-text.ts` (a "Serves" line)
- Test: `packages/plugin-backlog/test/backlog.test.ts`

**Interfaces:**
- Produces:
  - `PlanParams.serves?: string`, the statement's ref with its version, for example `gherkin/outcome:O-0003@abc123def456`;
  - Backlog contract `dropServing: { params: { statement: string }, success: { ids: string[] } }`. It drops every Backlog-lane plan whose `serves` names that statement id, at any version, and answers the ids;
  - the first event of a plan with `serves` is `{ what: "planned", by: "Intent Agent" }`.

- [ ] **Step 1: Write the failing test** (append to `packages/plugin-backlog/test/backlog.test.ts`, inside its harness. Copy the setup of the nearest test that calls `h.invoke("backlog", "plan", …)`: `grep -n '"plan", {' packages/plugin-backlog/test/backlog.test.ts | head -3`)

```ts
test("a plan can serve a statement: the Intent Agent planned it; dropServing drops only its Backlog-lane plans", async () => {
  const out = await run((seen) =>
    Effect.gen(function* () {
      yield* setUp
      const h = yield* PluginHost
      const base = { journey: "", scenarios: [], changes: [{ tool: "edit-scenario", params: { id: "S-0001", title: "x" } }], feedback: [], steps: ["x"] }
      const a = (yield* h.invoke("backlog", "plan", { ...base, title: "A", serves: "gherkin/outcome:O-0001@aaaaaaaaaaaa" })) as { id: string }
      const b = (yield* h.invoke("backlog", "plan", { ...base, title: "B", serves: "gherkin/outcome:O-0001@bbbbbbbbbbbb" })) as { id: string }
      const c = (yield* h.invoke("backlog", "plan", { ...base, title: "C", serves: "gherkin/outcome:O-0002@cccccccccccc" })) as { id: string }
      // The operator chose B already: it is Ready, so it stays.
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "move", rows: [b.id], text: "ready" })
      const dropped = yield* h.invoke("backlog", "dropServing", { statement: "O-0001" })
      const item = (id: string) => Effect.map(h.entities.get(`backlog/item:${id}`), (e) => e.data as { dropped?: boolean; events: ReadonlyArray<{ by: string }> })
      return { dropped, a: yield* item(a.id), b: yield* item(b.id), c: yield* item(c.id) }
    }),
  )
  expect(out.dropped).toEqual({ ids: [expect.stringMatching(/^B-\d+$/)] })
  expect(out.a.dropped).toBe(true)
  expect(out.a.events[0]!.by).toBe("Intent Agent")
  expect(out.b.dropped).toBeUndefined()
  expect(out.c.dropped).toBeUndefined()
})
```
Before running it, check how this test file moves a plan to Ready (`grep -n '"move"' packages/plugin-backlog/test/backlog.test.ts | head -3`) and use the same call. If the board's move uses another action or arg, adapt the line and note it in the ledger.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/plugin-backlog && mise x -- bun test test/backlog.test.ts -t "serve a statement"`
Expected: FAIL. `serves` is rejected by `PlanParams`, or `dropServing` is not a method.

- [ ] **Step 3: Implement**

`contract.ts`, in `PlanParams`:
```ts
  /** The intent statement this plan serves (the Intent Agent's plans): its ref with the version drafted on. */
  serves: Schema.optionalKey(Schema.String),
```
and in the `Backlog` contract:
```ts
  dropServing: { params: Schema.Struct({ statement: Schema.String }), success: Schema.Struct({ ids: Schema.Array(Schema.String) }) },
```
`items.ts` `Item`: `readonly serves?: string`.

`index.ts`:
- the `plan` event: `events: [{ what: "planned", by: p.kind === "code" ? "operator" : p.serves !== undefined ? "Intent Agent" : "Triage Agent" }]`;
- the method list (next to `plans:`): `dropServing: { doc: "Drop the Backlog-lane plans serving a statement (it was removed): the Intent Agent's call.", params: Schema.Struct({ statement: Schema.String }), success: Schema.Struct({ ids: Schema.Array(Schema.String) }) },`;
- the implementation, next to `drop`:
```ts
    /** A removed statement's plans still in Backlog are dropped; one the operator moved on stays theirs. */
    const dropServing = ({ statement }: { statement: string }) =>
      Effect.gen(function* () {
        const mine = (yield* loadItems).filter((i) => i.status === "backlog" && i.dropped !== true && i.serves !== undefined && parseRef(i.serves)?.id === statement)
        for (const i of mine) yield* drop(i.id)
        return { ids: mine.map((i) => i.id) }
      }).pipe(Effect.mapError(fail))
```
  Add `dropServing` to the returned handlers. `drop` takes the `writing` permit itself, so `dropServing` must not take it as well. `parseRef` is already imported in `items.ts`; import it in `index.ts` from `@zarg/entities` if it is missing there.
- the drawer: in the Plan tab's header lines, which `planText` builds, add a line after the title when `i.serves !== undefined`:
```ts
    ...(i.serves !== undefined ? [`Serves ${parseRef(i.serves)?.id ?? i.serves}`] : []),
```
  In `plan-text.ts`, add `"serves"` to the `Pick<Item, …>` list and insert that line in the header block right after the title line.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/plugin-backlog && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/plugin-backlog && git commit -m "feat(backlog): a plan may serve an intent statement; dropServing for a removed one

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `makeIntent` — what is due, rounds, plans, the checkpoint

**Files:**
- Create: `packages/agent-intent/package.json`, `mise.toml`, `tsconfig.json`
- Create: `packages/agent-intent/src/checkpoint.ts`, `packages/agent-intent/src/intent.ts`
- Test: `packages/agent-intent/test/checkpoint.test.ts`, `packages/agent-intent/test/intent.test.ts`

**Interfaces:**
- Consumes: `@zarg/fold` (`fold`, `dependencies`, `merge`, `jsonIn`, `Unit`, `Folded`); the Backlog plan params (Task 2).
- Produces (`checkpoint.ts`):
```ts
export type Entry = { readonly version: string; readonly state: "planned" | "asked" | "left" | "nothing"; readonly plans?: ReadonlyArray<string>; readonly topic?: string; readonly decision?: string; readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }> }
export type Checkpoint = { readonly statements: Readonly<Record<string, Entry>>; readonly journeys: Readonly<Record<string, Entry>> }
export const EMPTY: Checkpoint
export type Statement = { readonly id: string; readonly kind: "outcome" | "constraint"; readonly text: string; readonly version: string; readonly intent: { readonly id: string; readonly title: string; readonly problem?: string }; readonly journeys: ReadonlyArray<string> }
export type JourneyInfo = { readonly id: string; readonly name: string; readonly version: string; readonly scenarios: ReadonlyArray<string>; readonly serves: ReadonlyArray<string> }
export type Due = { readonly kind: "statement"; readonly statement: Statement } | { readonly kind: "journey"; readonly journey: JourneyInfo } | { readonly kind: "removed"; readonly id: string }
export const due: (statements, journeys, cp, outcomesExist: boolean) => ReadonlyArray<Due>
```
- Produces (`intent.ts`): `IntentDeps` (below), `makeIntent(d: IntentDeps, reasoning = false) → { tick: Effect<void>, rounds: () => ReadonlyArray<RoundView>, answered: (topicKey: string, answer: string | undefined, text: string | undefined) => Effect<string> }`, and `SYSTEM: string`. `RoundView = { id: string; title: string; state: "drafting" | "planned" | "asked" | "left" | "nothing" | "waiting"; detail: string; plans: ReadonlyArray<string> }`.

- [ ] **Step 1: Create the package**

```bash
mkdir -p packages/agent-intent/src packages/agent-intent/test
cp packages/agent-triage/tsconfig.json packages/agent-triage/mise.toml packages/agent-intent/
cat > packages/agent-intent/package.json <<'EOF'
{
  "name": "@zarg/agent-intent",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@zarg/entities": "workspace:*",
    "@zarg/fold": "workspace:*",
    "@zarg/plugin-backlog": "workspace:*",
    "@zarg/plugin-gherkin": "workspace:*",
    "@zarg/plugin-sdk": "workspace:*",
    "effect": "^4.0.0-rc.117"
  },
  "devDependencies": {
    "@effect/platform-bun": "^4.0.0-rc.117",
    "@zarg/graph": "workspace:*",
    "@zarg/plugin": "workspace:*"
  }
}
EOF
mise x -- bun install
```
Copy the `effect` versions from `packages/agent-triage/package.json`; if its line differs, use its exact version.

- [ ] **Step 2: Write the failing tests for `due`** (`test/checkpoint.test.ts`)

```ts
import { expect, test } from "bun:test"
import { due, EMPTY, type JourneyInfo, type Statement } from "../src/checkpoint"

const intent = { id: "I-0001", title: "Plans" }
const o = (id: string, version: string, journeys: ReadonlyArray<string> = []): Statement => ({ id, kind: "outcome", text: `text ${id}`, version, intent, journeys })
const j = (id: string, version: string, serves: ReadonlyArray<string> = []): JourneyInfo => ({ id, name: `journey ${id}`, version, scenarios: [], serves })

test("new, changed and answered statements are due; the same version planned or asked is not", () => {
  const cp = { statements: { "O-0002": { version: "v2", state: "planned" as const }, "O-0003": { version: "old", state: "planned" as const }, "O-0004": { version: "v4", state: "asked" as const, topic: "T-1" }, "O-0005": { version: "v5", state: "asked" as const, decision: "Add to Checkout" } }, journeys: {} }
  const ids = due([o("O-0001", "v1"), o("O-0002", "v2"), o("O-0003", "new"), o("O-0004", "v4"), o("O-0005", "v5")], [], cp, true).map((d) => (d.kind === "statement" ? d.statement.id : d.kind))
  expect(ids).toEqual(["O-0001", "O-0003", "O-0005"])
})
test("a statement in the checkpoint but no longer in the graph is removed", () => {
  expect(due([], [], { statements: { "O-0009": { version: "v", state: "planned" } }, journeys: {} }, false)).toEqual([{ kind: "removed", id: "O-0009" }])
})
test("an unserving journey is due once per version, and only while outcomes exist", () => {
  expect(due([], [j("J-0001", "v1"), j("J-0002", "v1", ["O-0001"])], EMPTY, true).map((d) => (d.kind === "journey" ? d.journey.id : d.kind))).toEqual(["J-0001"])
  expect(due([], [j("J-0001", "v1")], { statements: {}, journeys: { "J-0001": { version: "v1", state: "nothing" } } }, true)).toEqual([])
  expect(due([], [j("J-0001", "v1")], EMPTY, false)).toEqual([])
})
test("statements come before journeys; removed ones first of all", () => {
  const kinds = due([o("O-0001", "v1")], [j("J-0001", "v1")], { statements: { "O-0009": { version: "v", state: "planned" } }, journeys: {} }, true).map((d) => d.kind)
  expect(kinds).toEqual(["removed", "statement", "journey"])
})
```

- [ ] **Step 3: Implement `checkpoint.ts`**

```ts
/** What the intent agent already reconciled: each statement's and journey's version, and where its round ended. */
export type Entry = {
  readonly version: string
  /** planned: plans filed; asked: an inbox topic waits; left: drafts failed (a topic says why); nothing: no change needed. */
  readonly state: "planned" | "asked" | "left" | "nothing"
  readonly plans?: ReadonlyArray<string>
  readonly topic?: string
  /** The operator's answer to the topic: the next round follows it. */
  readonly decision?: string
  /** The answers the topic offered (an answer's label is what the model reads). */
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>
}
export type Checkpoint = { readonly statements: Readonly<Record<string, Entry>>; readonly journeys: Readonly<Record<string, Entry>> }
export const EMPTY: Checkpoint = { statements: {}, journeys: {} }

export type Statement = {
  readonly id: string
  readonly kind: "outcome" | "constraint"
  readonly text: string
  readonly version: string
  readonly intent: { readonly id: string; readonly title: string; readonly problem?: string }
  /** The journeys serving it (an outcome) or that it bounds (a constraint). */
  readonly journeys: ReadonlyArray<string>
}
export type JourneyInfo = { readonly id: string; readonly name: string; readonly version: string; readonly scenarios: ReadonlyArray<string>; readonly serves: ReadonlyArray<string> }
export type Due = { readonly kind: "statement"; readonly statement: Statement } | { readonly kind: "journey"; readonly journey: JourneyInfo } | { readonly kind: "removed"; readonly id: string }

/**
 * What needs a round: a removed statement (its plans go), a statement that is new, changed or answered, and a journey serving
 * nothing (once per version, only while there are outcomes to serve). The same version planned, asked or settled is not due:
 * a tick with nothing due costs nothing.
 */
export const due = (statements: ReadonlyArray<Statement>, journeys: ReadonlyArray<JourneyInfo>, cp: Checkpoint, outcomesExist: boolean): ReadonlyArray<Due> => {
  const present = new Set(statements.map((s) => s.id))
  const removed: Array<Due> = Object.keys(cp.statements).filter((id) => !present.has(id)).sort().map((id) => ({ kind: "removed", id }))
  const changed: Array<Due> = statements
    .filter((s) => { const e = cp.statements[s.id]; return e === undefined || e.version !== s.version || e.decision !== undefined })
    .map((statement) => ({ kind: "statement", statement }))
  const unserving: Array<Due> = !outcomesExist ? [] : journeys
    .filter((j) => j.serves.length === 0 && cp.journeys[j.id]?.version !== j.version)
    .map((journey) => ({ kind: "journey", journey }))
  return [...removed, ...changed, ...unserving]
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd packages/agent-intent && mise x -- bun test test/checkpoint.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing tests for rounds** (`test/intent.test.ts`)

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Checkpoint, JourneyInfo, Statement } from "../src/checkpoint"
import { type IntentDeps, makeIntent } from "../src/intent"

const intent = { id: "I-0001", title: "Plans", problem: "Visitors leave." }
const outcome: Statement = { id: "O-0001", kind: "outcome", text: "A visitor picks a plan in one minute", version: "v1", intent, journeys: [] }
const checkout: JourneyInfo = { id: "J-0001", name: "Checkout", version: "jv", scenarios: ["S-0001"], serves: ["O-0001"] }
const unit = (scenario: string, changes: ReadonlyArray<unknown>) => ({ scenario, title: `t ${scenario}`, summary: `s ${scenario}`, changes })

const setup = (o: { statements?: ReadonlyArray<Statement>; journeys?: ReadonlyArray<JourneyInfo>; answers?: ReadonlyArray<string>; cp?: Checkpoint; down?: boolean; dry?: (n: number) => { ok: boolean; problems: string[] }; versionAfter?: string }) => {
  const calls: Array<[string, unknown]> = []
  const answers = [...(o.answers ?? [])]
  let cp: Checkpoint = o.cp ?? { statements: {}, journeys: {} }
  let dries = 0
  let reads = 0
  const deps: IntentDeps = {
    statements: () => Effect.sync(() => (reads++, (o.statements ?? [outcome]).map((s) => (o.versionAfter !== undefined && reads > 1 ? { ...s, version: o.versionAfter } : s)))),
    journeys: () => Effect.succeed(o.journeys ?? []),
    scene: (scenario) => Effect.succeed(`${scenario} title\nGiven a\nWhen b\nThen c`),
    code: () => Effect.succeed([]),
    dryRun: (draft) => Effect.sync(() => ({ scenarios: draft.length > 0 ? ["S-0001"] : [], ...(o.dry?.(dries++) ?? { ok: true, problems: [] }) })),
    complete: (req) => (o.down === true ? Effect.fail("down") : Effect.sync(() => (calls.push(["complete", req.messages.at(-1)?.content]), { text: answers.shift() ?? "no json" }))),
    version: (ref) => Effect.succeed(`${ref.split(":")[1]}-ver`),
    plan: (p) => Effect.sync(() => (calls.push(["plan", p]), { id: `B-${calls.filter(([k]) => k === "plan").length}` })),
    dropServing: (statement) => Effect.sync(() => (calls.push(["dropServing", statement]), { ids: ["B-9"] })),
    post: (t) => Effect.sync(() => (calls.push(["post", t]), "T-1")),
    settle: (id, why) => Effect.sync(() => void calls.push(["settle", `${id}: ${why}`])),
    load: Effect.sync(() => cp),
    save: (c) => Effect.sync(() => void (cp = c)),
    log: (text) => Effect.sync(() => void calls.push(["log", text])),
    render: Effect.void,
  }
  return { a: makeIntent(deps), calls, cp: () => cp }
}

describe("the Intent Agent", () => {
  test("a new outcome: one round, its draft dry-run, one plan serving it, the checkpoint at its version", async () => {
    const answer = JSON.stringify({ units: [unit("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001", title: "Visitor picks a plan" } }])], steps: ["Shorten the pricing scenario"], ask: null })
    const { a, calls, cp } = setup({ journeys: [checkout], answers: [answer] })
    await Effect.runPromise(a.tick)
    expect(String(calls.find(([k]) => k === "complete")![1])).toContain("O-0001 (outcome): A visitor picks a plan in one minute")
    expect(calls.find(([k]) => k === "plan")![1]).toMatchObject({ title: "t S-0001", journey: "Checkout", serves: "gherkin/outcome:O-0001@v1", scenarios: [{ ref: "gherkin/scenario:S-0001@S-0001-ver" }], steps: ["Shorten the pricing scenario"], feedback: [] })
    expect(cp().statements["O-0001"]).toEqual({ version: "v1", state: "planned", plans: ["B-1"] })
  })

  test("nothing due: no model call, nothing filed", async () => {
    const { a, calls } = setup({ cp: { statements: { "O-0001": { version: "v1", state: "planned" } }, journeys: {} } })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "complete" || k === "plan" || k === "post")).toEqual([])
  })

  test("the model asks: a topic with its options; the round waits; the answer makes it due with the decision", async () => {
    const ask = JSON.stringify({ units: [], steps: [], ask: { question: "O-0001 has no journey: add to Checkout, or a new journey?", options: [{ id: "J-0001", label: "Add to Checkout" }, { id: "new", label: "A new journey" }] } })
    const { a, calls, cp } = setup({ answers: [ask] })
    await Effect.runPromise(a.tick)
    expect(calls.find(([k]) => k === "post")![1]).toMatchObject({ kind: "ask", key: "decide:O-0001", title: "O-0001 has no journey: add to Checkout, or a new journey?", answers: [{ id: "J-0001", label: "Add to Checkout" }, { id: "new", label: "A new journey" }, { id: "leave", label: "Leave it" }] })
    expect(cp().statements["O-0001"]).toEqual({ version: "v1", state: "asked", topic: "T-1", options: [{ id: "J-0001", label: "Add to Checkout" }, { id: "new", label: "A new journey" }, { id: "leave", label: "Leave it" }] })
    expect(await Effect.runPromise(a.answered("decide:O-0001", "J-0001", undefined))).toBe("O-0001: drafting again with your answer")
    expect(cp().statements["O-0001"]!.decision).toBe("Add to Checkout")
  })

  test("an answer to a statement that changed or went is ignored, saying so", async () => {
    const { a } = setup({ cp: { statements: { "O-0001": { version: "old", state: "asked", topic: "T-1" } }, journeys: {} } })
    expect(await Effect.runPromise(a.answered("decide:O-0001", "J-0001", undefined))).toBe("O-0001 changed since it asked: its next round starts fresh")
    expect(await Effect.runPromise(a.answered("decide:O-0042", "J-0001", undefined))).toBe("O-0042 is gone")
  })

  test("a draft that fails its dry-run is tried again with the problems, up to 3 tries; then left out with a topic", async () => {
    const answer = JSON.stringify({ units: [unit("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001" } }])], steps: [], ask: null })
    const { a, calls, cp } = setup({ answers: [answer, answer, answer], dry: () => ({ ok: false, problems: ["S-0001: a clause has if"] }) })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "complete").length).toBe(3)
    expect(String(calls.filter(([k]) => k === "complete")[1]![1])).toContain("S-0001: a clause has if")
    expect(calls.find(([k]) => k === "post")![1]).toMatchObject({ key: "left:O-0001", answers: [{ id: "again", label: "Draft again" }, { id: "leave", label: "Leave it" }] })
    expect(cp().statements["O-0001"]!.state).toBe("left")
    expect(calls.filter(([k]) => k === "plan")).toEqual([])
  })

  test("the model down or answering no JSON: one log line, nothing filed, nothing checkpointed", async () => {
    for (const o of [{ down: true }, { answers: ["I think it is fine"] }]) {
      const { a, calls, cp } = setup(o)
      await Effect.runPromise(a.tick)
      expect(calls.filter(([k]) => k === "plan" || k === "post")).toEqual([])
      expect(cp().statements).toEqual({})
      expect(calls.filter(([k]) => k === "log").map(([, t]) => String(t)).some((t) => t.includes("O-0001") && t.includes("next wake"))).toBe(true)
    }
  })

  test("a statement that changed while drafting files nothing and stays due", async () => {
    const answer = JSON.stringify({ units: [unit("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001" } }])], steps: [], ask: null })
    const { a, calls, cp } = setup({ answers: [answer], versionAfter: "v2" })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "plan")).toEqual([])
    expect(cp().statements["O-0001"]).toBeUndefined()
  })

  test("a removed statement: its Backlog plans dropped, its open topic settled, its entry gone", async () => {
    const { a, calls, cp } = setup({ statements: [], cp: { statements: { "O-0007": { version: "v", state: "asked", topic: "T-7" } }, journeys: {} } })
    await Effect.runPromise(a.tick)
    expect(calls.find(([k]) => k === "dropServing")![1]).toBe("O-0007")
    expect(calls.find(([k]) => k === "settle")![1]).toBe("T-7: its statement was removed")
    expect(cp().statements).toEqual({})
  })

  test("an unserving journey: the model names the outcomes it serves; a plan links them", async () => {
    const browse: JourneyInfo = { id: "J-0002", name: "Browse", version: "bv", scenarios: ["S-0002"], serves: [] }
    const { a, calls, cp } = setup({ cp: { statements: { "O-0001": { version: "v1", state: "planned" } }, journeys: {} }, journeys: [checkout, browse], answers: [JSON.stringify({ serves: ["O-0001"], ask: null })] })
    await Effect.runPromise(a.tick)
    expect(calls.find(([k]) => k === "plan")![1]).toMatchObject({ title: "Browse serves O-0001", journey: "Browse", changes: [{ tool: "link", params: { edge: "serves", journey: { id: "J-0002" }, outcome: "O-0001" } }] })
    expect(cp().journeys["J-0002"]).toEqual({ version: "bv", state: "planned", plans: ["B-1"] })
  })
})
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd packages/agent-intent && mise x -- bun test test/intent.test.ts`
Expected: FAIL (`../src/intent` is not found).

- [ ] **Step 7: Implement `intent.ts`**

```ts
import { Effect } from "effect"
import { dependencies, fold, type Folded, jsonIn, merge, type Unit } from "@zarg/fold"
import { type Checkpoint, due, type Entry, type JourneyInfo, type Statement } from "./checkpoint"

type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
type Topic = { readonly kind: string; readonly key: string; readonly title: string; readonly why: string; readonly about: ReadonlyArray<string>; readonly answers: ReadonlyArray<{ readonly id: string; readonly label: string; readonly recommended?: boolean }>; readonly evidence?: string }

/** The Intent Agent's powers, as plain functions (the plugin wires them to its contracts; tests stub them). */
export interface IntentDeps {
  readonly statements: () => Effect.Effect<ReadonlyArray<Statement>, unknown>
  readonly journeys: () => Effect.Effect<ReadonlyArray<JourneyInfo>, unknown>
  /** A scenario as Gherkin text, as it is now. */
  readonly scene: (scenario: string) => Effect.Effect<string, unknown>
  readonly code: (scenario: string) => Effect.Effect<ReadonlyArray<{ readonly file: string; readonly line: number; readonly text: string }>, unknown>
  readonly dryRun: (draft: Draft) => Effect.Effect<{ readonly ok: boolean; readonly problems: ReadonlyArray<string>; readonly scenarios?: ReadonlyArray<string> }, unknown>
  readonly complete: (req: { readonly messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>; readonly maxTokens?: number; readonly reasoning?: { readonly enabled: boolean } }) => Effect.Effect<{ readonly text: string }, unknown>
  /** An entity's version now (null: gone). */
  readonly version: (ref: string) => Effect.Effect<string | null, unknown>
  readonly plan: (p: { readonly title: string; readonly journey: string; readonly scenarios: ReadonlyArray<{ readonly ref: string }>; readonly changes: Draft; readonly feedback: ReadonlyArray<string>; readonly steps: ReadonlyArray<string>; readonly after?: ReadonlyArray<string>; readonly serves: string }) => Effect.Effect<{ readonly id: string }, unknown>
  readonly dropServing: (statement: string) => Effect.Effect<{ readonly ids: ReadonlyArray<string> }, unknown>
  readonly post: (t: Topic) => Effect.Effect<string, unknown>
  readonly settle: (topic: string, why: string) => Effect.Effect<void, unknown>
  readonly load: Effect.Effect<Checkpoint, unknown>
  readonly save: (cp: Checkpoint) => Effect.Effect<void, unknown>
  readonly log: (text: string) => Effect.Effect<void, unknown>
  /** Draw the agent's view again. */
  readonly render: Effect.Effect<void, unknown>
}

export type RoundView = { readonly id: string; readonly title: string; readonly state: "drafting" | "planned" | "asked" | "left" | "nothing" | "waiting"; readonly detail: string; readonly plans: ReadonlyArray<string> }

const TOOLS = [
  'add-scenario {"title":"Who does what","when":"the one action","by":[{"name":"Operator"}],"arrives":{"id":"ST-0001"},"then":[{"text":"…"}],"given":[]}: a new scenario (1-5 thens)',
  'edit-scenario {"id":"S-0001","title":"…","when":"…"}: change a scenario\'s title or When',
  'edit-state {"id":"ST-0002","text":"…"}: reword a Given/Then sentence (every scenario using it changes)',
  'link {"scenario":"S-0001","edge":"then","state":{"text":"…"}}: add a then (given, arrives likewise); {"scenario":"S-0001","edge":"in","journey":{"id":"J-0001"}} puts it in a journey',
  'unlink {"scenario":"S-0001","edge":"then","state":"ST-0002"}: remove one',
  'add-journey {"name":"…"}: a new journey (then link its scenarios with in)',
  'link {"edge":"serves","journey":{"id":"J-0001"},"outcome":"O-0001"}: the journey delivers the outcome',
  'link {"edge":"bounds","constraint":"K-0001","journey":{"id":"J-0001"}}: the constraint applies to a journey (or "scenario":"S-0001")',
].join("\n")
export const SYSTEM = [
  "You turn a product's intent into its requirements: Gherkin scenarios (Given, When, Then) in journeys.",
  "One statement of the intent changed, is new, or no journey delivers it yet. Propose the smallest change to the graph that makes the journeys deliver it (an outcome) or respect it (a constraint), as gherkin tool calls in order, grouped by the scenario each changes (\"new:<short name>\" for a new one).",
  "Clauses at most 15 words, never 'if' (one scenario per case). Titles start with the persona's name. Refer to states that exist by id; name every new state by text.",
  `Tools:\n${TOOLS}`,
  "When the journeys already deliver it, answer no units. When it needs the operator's choice (which journey, which of two meanings, a conflict with a scenario), answer an ask with 2-4 options instead of guessing.",
  'Answer with JSON only: {"units":[{"scenario":"S-0001","title":"…","summary":"one sentence","changes":[{"tool":"…","params":{…}}]}],"steps":["one line per step, for the operator"],"ask":null or {"question":"…","options":[{"id":"…","label":"…"}]}}.',
].join("\n\n")
const JOURNEY_SYSTEM = [
  "A journey of a product serves no outcome of its intent. Say which outcomes it delivers (one or more ids), or ask the operator when none fits.",
  'Answer with JSON only: {"serves":["O-0001"],"ask":null or {"question":"…","options":[{"id":"…","label":"…"}]}}.',
].join("\n\n")
const TRIES = 3
const LEAVE = { id: "leave", label: "Leave it" } as const

/** The Intent Agent: rounds over what is due, one at a time, whenever the core wakes it. */
export const makeIntent = (d: IntentDeps, reasoning = false) => {
  const quiet = <A>(e: Effect.Effect<A, unknown>) => Effect.ignore(e)
  const views = new Map<string, RoundView>()
  const show = (v: RoundView) => Effect.andThen(Effect.sync(() => void views.set(v.id, v)), quiet(d.render))
  const ask = (system: string, user: string) =>
    d.complete({ messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 16384, ...(reasoning ? {} : { reasoning: { enabled: false } }) }).pipe(Effect.map((r) => r.text), Effect.orElseSucceed(() => undefined))
  const update = (f: (cp: Checkpoint) => Checkpoint) => Effect.flatMap(d.load, (cp) => d.save(f(cp)))
  const setStatement = (id: string, e: Entry | undefined) =>
    update((cp) => { const statements = { ...cp.statements }; if (e === undefined) delete statements[id]; else statements[id] = e; return { ...cp, statements } })
  const setJourney = (id: string, e: Entry) => update((cp) => ({ ...cp, journeys: { ...cp.journeys, [id]: e } }))
  const OUTAGE = (id: string) => `${id}: the driver model did not answer with JSON; the Intent Agent tries again on the next wake`

  /** The context a round reads: the statement, its intent, its journeys with their scenarios and code. */
  const contextOf = (s: Statement, journeys: ReadonlyArray<JourneyInfo>) =>
    Effect.gen(function* () {
      const mine = journeys.filter((j) => s.journeys.includes(j.id))
      const blocks = yield* Effect.forEach(mine, (j) =>
        Effect.gen(function* () {
          const scenes = yield* Effect.forEach(j.scenarios, (c) =>
            Effect.gen(function* () {
              const text = yield* d.scene(c).pipe(Effect.orElseSucceed(() => `${c} (not in the graph)`))
              const code = yield* d.code(c).pipe(Effect.orElseSucceed(() => []))
              return [text, ...(code.length > 0 ? ["What zarg does now:", ...code.slice(0, 2).map((x) => `${x.file}:${x.line}\n${x.text.split("\n").slice(0, 20).join("\n")}`)] : [])].join("\n")
            }),
          )
          return [`## ${j.id} ${j.name}`, ...scenes].join("\n\n")
        }),
      )
      return [
        `Intent ${s.intent.id}: ${s.intent.title}`,
        ...(s.intent.problem !== undefined ? [`Problem: ${s.intent.problem}`] : []),
        "",
        `${s.id} (${s.kind}): ${s.text}`,
        "",
        mine.length > 0 ? (s.kind === "outcome" ? "Journeys that serve it:" : "Journeys it bounds:") : "No journey serves it yet. Journeys:",
        ...(mine.length > 0 ? blocks : journeys.map((j) => `- ${j.id} ${j.name}`)),
      ].join("\n")
    })

  /** Parsed units, or an ask, or undefined (no JSON: an outage for this round). */
  const parse = (text: string | undefined) => {
    if (text === undefined) return undefined
    const v = jsonIn(text) as { units?: unknown; steps?: unknown; ask?: unknown } | undefined
    if (v === undefined || !Array.isArray(v.units)) return undefined
    const units = (v.units as ReadonlyArray<Record<string, unknown>>).filter((u) => typeof u?.scenario === "string" && Array.isArray(u.changes)).map((u): Unit => ({ scenario: String(u.scenario), title: String(u.title ?? u.scenario), summary: String(u.summary ?? ""), changes: u.changes as Draft, answers: [] }))
    const a = v.ask as { question?: unknown; options?: unknown } | null | undefined
    const asked = a !== null && a !== undefined && typeof a.question === "string" && Array.isArray(a.options) ? { question: a.question, options: (a.options as ReadonlyArray<{ id?: unknown; label?: unknown }>).filter((x) => typeof x?.id === "string" && typeof x?.label === "string").map((x) => ({ id: String(x.id), label: String(x.label) })) } : undefined
    return { units, steps: Array.isArray(v.steps) ? v.steps.filter((x): x is string => typeof x === "string") : [], ask: asked }
  }

  /** The round's units folded into plans, each dry-run over the plans it waits on (one that fails merges into them). */
  const plansOf = (units: ReadonlyArray<Unit>) =>
    Effect.gen(function* () {
      const deps = dependencies(units)
      let plans: Array<Folded> = fold(units, deps)
      const changesOf = (p: Folded) => p.units.flatMap((u) => units[u]!.changes)
      const before = (k: number): ReadonlyArray<number> => [...new Set(plans[k]!.after.flatMap((j) => [...before(j), j]))].sort((x, y) => x - y)
      for (let pass = 0; pass < units.length && plans.length > 1; pass++) {
        let bad: number | undefined
        for (let k = 0; k < plans.length && bad === undefined; k++) {
          const dry = yield* d.dryRun([...before(k).flatMap((j) => changesOf(plans[j]!)), ...changesOf(plans[k]!)]).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: [] })))
          if (!dry.ok) bad = k
        }
        if (bad === undefined) break
        plans = merge(plans, bad)
      }
      return plans.map((p) => ({ title: p.title, steps: p.steps, changes: changesOf(p), scenarios: p.units.map((u) => units[u]!.scenario).filter((c) => /^S-\d/.test(c)), after: p.after }))
    })

  /** One statement's round: draft (up to TRIES), ask or file, checkpoint; nothing filed when it changed meanwhile. */
  const statementRound = (s: Statement, journeys: ReadonlyArray<JourneyInfo>, decision: string | undefined) =>
    Effect.gen(function* () {
      yield* show({ id: s.id, title: s.text, state: "drafting", detail: "", plans: [] })
      const context = yield* contextOf(s, journeys)
      let problems: ReadonlyArray<string> = []
      for (let t = 1; t <= TRIES; t++) {
        const user = [context, ...(decision !== undefined ? ["", `The operator decided: ${decision}`] : []), ...(problems.length > 0 ? ["", "Your last answer failed its checks:", ...problems.map((p) => `- ${p}`), "Fix them."] : [])].join("\n")
        const r = parse(yield* ask(SYSTEM, user))
        if (r === undefined) {
          yield* quiet(d.log(OUTAGE(s.id)))
          return yield* show({ id: s.id, title: s.text, state: "waiting", detail: "the driver model did not answer", plans: [] })
        }
        if (r.ask !== undefined && r.units.length === 0) {
          const options = [...r.ask.options, LEAVE]
          const topic = yield* d.post({ kind: "ask", key: `decide:${s.id}`, title: r.ask.question, why: `intent ${s.intent.id}`, about: [s.id], answers: options })
          yield* setStatement(s.id, { version: s.version, state: "asked", topic, options })
          return yield* show({ id: s.id, title: s.text, state: "asked", detail: r.ask.question, plans: [] })
        }
        if (r.units.length === 0) {
          yield* setStatement(s.id, { version: s.version, state: "nothing" })
          yield* quiet(d.log(`${s.id}: the journeys already deliver it`))
          return yield* show({ id: s.id, title: s.text, state: "nothing", detail: "the journeys already deliver it", plans: [] })
        }
        const dry = yield* d.dryRun(r.units.flatMap((u) => u.changes)).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: ["the dry run could not run"] })))
        if (!dry.ok) {
          problems = dry.problems
          continue
        }
        // The statement as it is now: changed meanwhile, nothing is filed and the next tick drafts it again.
        const now = (yield* d.statements()).find((x) => x.id === s.id)
        if (now === undefined || now.version !== s.version) {
          yield* quiet(d.log(`${s.id} changed while drafting: drafting it again on the next wake`))
          return yield* show({ id: s.id, title: s.text, state: "waiting", detail: "changed while drafting", plans: [] })
        }
        const serves = `gherkin/${s.kind}:${s.id}@${s.version}`
        const journey = journeys.find((j) => s.journeys.includes(j.id))?.name ?? ""
        const ids: Array<string> = []
        for (const p of yield* plansOf(r.units)) {
          const scenarios = yield* Effect.forEach(p.scenarios, (c) => Effect.map(d.version(`gherkin/scenario:${c}`).pipe(Effect.orElseSucceed(() => null)), (v) => (v === null ? [] : [{ ref: `gherkin/scenario:${c}@${v}` }])))
          const after = p.after.flatMap((k) => (ids[k] !== undefined ? [ids[k]!] : []))
          const { id } = yield* d.plan({ title: p.title, journey, scenarios: scenarios.flat(), changes: p.changes, feedback: [], steps: p.steps.length > 0 ? p.steps : r.steps, serves, ...(after.length > 0 ? { after } : {}) })
          ids.push(id)
        }
        yield* setStatement(s.id, { version: s.version, state: "planned", plans: ids })
        yield* quiet(d.log(`${s.id}: ${ids.length} plan${ids.length === 1 ? "" : "s"} to the Backlog: ${ids.join(", ")}`))
        return yield* show({ id: s.id, title: s.text, state: "planned", detail: r.steps.join("\n"), plans: ids })
      }
      const topic = yield* d.post({ kind: "ask", key: `left:${s.id}`, title: `${s.id} could not be drafted: ${s.text}`, why: `intent ${s.intent.id}`, about: [s.id], answers: [{ id: "again", label: "Draft again", recommended: true }, LEAVE], evidence: problems.join("\n") })
      yield* setStatement(s.id, { version: s.version, state: "left", topic })
      return yield* show({ id: s.id, title: s.text, state: "left", detail: problems.join("\n"), plans: [] })
    })

  /** A journey serving nothing: which outcomes it serves, as one plan of serves links (or a question). */
  const journeyRound = (j: JourneyInfo, statements: ReadonlyArray<Statement>) =>
    Effect.gen(function* () {
      yield* show({ id: j.id, title: j.name, state: "drafting", detail: "", plans: [] })
      const scenes = yield* Effect.forEach(j.scenarios, (c) => d.scene(c).pipe(Effect.orElseSucceed(() => c)))
      const outcomes = statements.filter((s) => s.kind === "outcome")
      const text = yield* ask(JOURNEY_SYSTEM, [`Journey ${j.id} ${j.name}:`, ...scenes, "", "Outcomes:", ...outcomes.map((o) => `- ${o.id}: ${o.text}`)].join("\n\n"))
      const v = text === undefined ? undefined : (jsonIn(text) as { serves?: unknown; ask?: { question?: unknown; options?: unknown } | null } | undefined)
      const serves = Array.isArray(v?.serves) ? v.serves.filter((x): x is string => typeof x === "string" && outcomes.some((o) => o.id === x)) : []
      if (v === undefined) {
        yield* quiet(d.log(OUTAGE(j.id)))
        return yield* show({ id: j.id, title: j.name, state: "waiting", detail: "the driver model did not answer", plans: [] })
      }
      if (serves.length === 0) {
        const q = typeof v.ask?.question === "string" ? v.ask.question : `${j.name} serves no outcome: which does it deliver?`
        const options = Array.isArray(v.ask?.options) ? (v.ask!.options as ReadonlyArray<{ id?: unknown; label?: unknown }>).filter((x) => typeof x?.id === "string" && typeof x?.label === "string").map((x) => ({ id: String(x.id), label: String(x.label) })) : []
        const topic = yield* d.post({ kind: "ask", key: `serve:${j.id}`, title: q, why: "a journey serving no outcome", about: [j.id], answers: [...options, LEAVE] })
        yield* setJourney(j.id, { version: j.version, state: "asked", topic })
        return yield* show({ id: j.id, title: j.name, state: "asked", detail: q, plans: [] })
      }
      const changes = serves.map((o) => ({ tool: "link", params: { edge: "serves", journey: { id: j.id }, outcome: o } }))
      const statement = outcomes.find((o) => o.id === serves[0])!
      const { id } = yield* d.plan({ title: `${j.name} serves ${serves.join(", ")}`, journey: j.name, scenarios: [], changes, feedback: [], steps: serves.map((o) => `${j.name} delivers ${o}: ${outcomes.find((x) => x.id === o)!.text}`), serves: `gherkin/outcome:${statement.id}@${statement.version}` })
      yield* setJourney(j.id, { version: j.version, state: "planned", plans: [id] })
      return yield* show({ id: j.id, title: j.name, state: "planned", detail: `serves ${serves.join(", ")}`, plans: [id] })
    })

  /** Everything due, one round at a time. */
  const tick = Effect.gen(function* () {
    const statements = yield* d.statements().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Statement>))
    const journeys = yield* d.journeys().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<JourneyInfo>))
    const cp = yield* d.load
    for (const x of due(statements, journeys, cp, statements.some((s) => s.kind === "outcome"))) {
      // A topic still open about something that changed or went no longer matters: settle it.
      const prev = x.kind === "journey" ? undefined : (yield* d.load).statements[x.kind === "removed" ? x.id : x.statement.id]
      if (prev?.topic !== undefined && prev.decision === undefined) yield* quiet(d.settle(prev.topic, x.kind === "removed" ? "its statement was removed" : "its statement changed: a new round"))
      if (x.kind === "removed") {
        const { ids } = yield* d.dropServing(x.id).pipe(Effect.orElseSucceed(() => ({ ids: [] as ReadonlyArray<string> })))
        yield* setStatement(x.id, undefined)
        yield* quiet(d.log(`${x.id} was removed${ids.length > 0 ? `: dropped ${ids.join(", ")}` : ""}`))
        views.delete(x.id)
      } else if (x.kind === "statement") yield* statementRound(x.statement, journeys, (yield* d.load).statements[x.statement.id]?.decision)
      else yield* journeyRound(x.journey, statements)
    }
    yield* quiet(d.render)
  })

  /** The operator answered a topic: the statement is due again with the decision (or left as it is). */
  const answered = (key: string, answer: string | undefined, text: string | undefined) =>
    Effect.gen(function* () {
      const [kind, id] = key.split(":") as [string, string | undefined]
      if (id === undefined) return `no topic ${key}`
      const cp = yield* d.load
      if (kind === "serve") {
        if (answer === undefined || answer === LEAVE.id) return `${id}: left as it is`
        // The answer is an outcome id: one plan linking it.
        const s = (yield* d.statements()).find((x) => x.id === answer)
        if (s === undefined) return `${answer} is not an outcome`
        const { id: plan } = yield* d.plan({ title: `${id} serves ${answer}`, journey: id, scenarios: [], changes: [{ tool: "link", params: { edge: "serves", journey: { id }, outcome: answer } }], feedback: [], steps: [`${id} delivers ${answer}: ${s.text}`], serves: `gherkin/outcome:${s.id}@${s.version}` })
        yield* setJourney(id, { version: cp.journeys[id]?.version ?? "", state: "planned", plans: [plan] })
        return `${id}: ${plan} links it to ${answer}`
      }
      const s = (yield* d.statements()).find((x) => x.id === id)
      if (s === undefined) return `${id} is gone`
      const e = cp.statements[id]
      if (e === undefined || e.version !== s.version) {
        yield* setStatement(id, undefined)
        return `${id} changed since it asked: its next round starts fresh`
      }
      if (answer === undefined || answer === LEAVE.id) return `${id}: left as it is`
      // The model reads the answer's words (its label), with the operator's reason when they gave one.
      const chosen = e.options?.find((o) => o.id === answer)?.label ?? answer
      const decision = answer === "again" ? "draft it again" : text !== undefined && text !== "" ? `${chosen}: ${text}` : chosen
      // asked with a decision is due (checkpoint.ts): the next tick drafts it again.
      yield* setStatement(id, { ...e, state: "asked", decision })
      return `${id}: drafting again with your answer`
    })

  return { tick, answered, rounds: () => [...views.values()] }
}
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `cd packages/agent-intent && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS (every test in `checkpoint.test.ts` and `intent.test.ts`).

- [ ] **Step 9: Commit**

```bash
git add -A packages/agent-intent bun.lock && mise run verify && git commit -m "feat(intent): rounds from statements to plans, a checkpoint, the inbox for what it cannot decide

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The plugin — wiring, the view, the checkpoint file, answers

**Files:**
- Create: `packages/agent-intent/src/views.ts`, `src/view.ts`, `src/index.ts`
- Modify: `packages/plugin/scripts/build-plugins.ts:8` (`FIRST_PARTY`)
- Test: `packages/agent-intent/test/plugin.test.ts`

**Interfaces:**
- Consumes: `makeIntent` (Task 3); `Gherkin.scene`, `Gherkin.journeys` and `Gherkin.dryRun`; `Backlog.plan` and `Backlog.dropServing` (Task 2); `Entities.query`, `Entities.version` and `Entities.code`; `Models.complete`; `Inbox.post` and `Inbox.settle`; `Files.read` and `Files.write`.
- Produces the plugin `intent` (`archetype: "agent"`):
  - methods `tick` (deadline 30 min), `answered` (the inbox's) and `act`;
  - its agent `intent` with view `intent` (summary text, a rounds table, a detail that follows it);
  - the checkpoint at `.zarg/intent/checkpoint.json`.

- [ ] **Step 1: Write the failing test** (`test/plugin.test.ts`)

```ts
import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import { layer as graphLayer } from "@zarg/graph"
import { makeGrants } from "@zarg/plugin/runtime"
import { layer as hostLayer, type LoadedPlugin, PluginHost } from "@zarg/plugin/server"
import { buildPlugin } from "@zarg/plugin-sdk/tools"

const build = async (pkg: string): Promise<LoadedPlugin> => {
  const r = await buildPlugin(join(import.meta.dir, `../../${pkg}/src/index.ts`))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  return { manifest: r.manifest as never, bundle: r.bundle, origin: join(import.meta.dir, `../../${pkg}`) }
}

test("the Intent Agent loads with gherkin and the backlog; a tick over a graph without intents asks no model and files nothing", async () => {
  const plugins = await Promise.all(["plugin-gherkin", "plugin-backlog", "agent-intent"].map(build))
  const out = await Effect.gen(function* () {
    const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    const grants = yield* makeGrants({ file: join(mkdtempSync(join(tmpdir(), "zt-intent-")), "grants.json"), project: root })
    const seen = new Map<string, unknown>()
    const host = hostLayer(plugins, {
      agents: (_p, e) => { const ev = e as { event?: string; id?: string; section?: string; data?: unknown }; if (ev.event === "set") seen.set(`${ev.id}/${ev.section}`, ev.data) },
      grants, vault: () => Effect.succeed(undefined), config: () => ({}), ask: () => Effect.succeed("deny"), yolo: { on: () => true }, log: () => {}, redact: (t) => t, firstParty: () => true, projectRoot: root,
    })
    return yield* Effect.gen(function* () {
      const h = yield* PluginHost
      yield* h.loadWaiting
      const tick = yield* h.invoke("intent", "tick", {})
      return { names: h.manifests.map((m) => m.name), tick, summary: (seen.get("intent/summary") as { markdown?: string } | undefined)?.markdown }
    }).pipe(Effect.provide(Layer.provideMerge(host, graphLayer(join(root, ".zarg/graph")))))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)
  expect(out.names).toEqual(expect.arrayContaining(["gherkin", "backlog", "intent"]))
  expect(out.tick).toBeNull()
  expect(out.summary).toBe("No intents yet: nothing to reconcile.")
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/agent-intent && mise x -- bun test test/plugin.test.ts`
Expected: FAIL (`src/index.ts` is not found).

- [ ] **Step 3: Implement the views**

`src/views.ts`:
```ts
import { defineView } from "@zarg/plugin-sdk"

/** The Intent Agent: each statement or journey it reconciled, where its round ended, its plans. */
export const IntentView = defineView("intent", {
  summary: { kind: "text", role: "summary", title: "" },
  rounds: {
    kind: "table",
    role: "primary",
    title: "",
    columns: [
      { id: "id", label: "statement", ref: true, filter: "none" },
      { id: "state", label: "round", filter: "values", tones: { drafting: "accent", planned: "ok", asked: "attention", left: "error", nothing: "dim", waiting: "dim" } },
      { id: "plans", label: "plans", filter: "none" },
    ],
    actions: [{ id: "open", label: "Refresh", key: "r", on: "none" }],
  },
  detail: { kind: "text", role: "pinned", title: "", follows: "rounds", beside: "rounds" },
})
```
`src/view.ts`:
```ts
import type { RoundView } from "./intent"

const KIND: Readonly<Record<string, string>> = { O: "outcome", K: "constraint", J: "journey" }
/** The agent's view: a line of counts, a row per round (newest state), each round's detail. */
export const intentView = (rounds: ReadonlyArray<RoundView>) => ({
  summary: rounds.length === 0 ? "No intents yet: nothing to reconcile." : `**${rounds.filter((r) => r.state === "planned").length} planned** · ${rounds.filter((r) => r.state === "asked").length} asked · ${rounds.filter((r) => r.state === "left").length} left out · ${rounds.filter((r) => r.state === "drafting").length} drafting`,
  rows: rounds.map((r) => ({ id: r.id, cells: { id: `gherkin/${KIND[r.id[0]!] ?? "outcome"}:${r.id}`, state: r.state, plans: r.plans.join(", ") } })),
  details: Object.fromEntries(rounds.map((r) => [r.id, [`**${r.id}** ${r.title}`, "", r.detail || "—", ...(r.plans.length > 0 ? ["", `Plans: ${r.plans.join(", ")}`] : [])].join("\n")])),
})
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
import { Effect, Schema } from "effect"
import { parseRef } from "@zarg/entities"
import { Backlog } from "@zarg/plugin-backlog/contract"
import { Gherkin } from "@zarg/plugin-gherkin/contract"
import { Agents, Config, definePlugin, Entities, Files, Inbox, Models, Views } from "@zarg/plugin-sdk"
import { type Checkpoint, EMPTY, type JourneyInfo, type Statement } from "./checkpoint"
import { makeIntent } from "./intent"
import { intentView } from "./view"
import { IntentView } from "./views"

const FILE = ".zarg/intent/checkpoint.json"
type Data = { readonly props: Readonly<Record<string, unknown>>; readonly edges: ReadonlyArray<{ readonly type: string; readonly to: string }> }

/** The Intent Agent: reconciles the intent's outcomes and constraints into plans on the Backlog. */
export default definePlugin({
  name: "intent",
  service: "Intent",
  archetype: "agent",
  // reasoning: let the model reason before answering (off by default, as triage).
  config: Schema.Struct({ reasoning: Schema.optionalKey(Schema.Boolean) }),
  pluginDependencies: [Gherkin, Backlog],
  scopes: { models: ["driver"], agents: true, inbox: true, code: true, entities: { read: ["gherkin/*"] }, fs: { read: [".zarg/intent/**"], write: [".zarg/intent/**"] } },
  views: [IntentView],
  methods: {
    tick: { doc: "Reconcile what is due: changed, new or uncovered statements and journeys serving nothing, one round at a time (the core wakes it when the graph changes).", params: Schema.Struct({}), success: Schema.Null, deadlineMs: 30 * 60_000 },
    answered: { doc: "The operator answered one of the Intent Agent's inbox topics.", params: Schema.Struct({ id: Schema.String, key: Schema.optionalKey(Schema.String), answer: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }), success: Schema.Struct({ notice: Schema.String }) },
    act: { doc: "The Intent Agent's view: r refreshes it.", params: Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) }), success: Schema.Struct({ notice: Schema.String }) },
  },
  make: Effect.gen(function* () {
    const gherkin = yield* Gherkin
    const backlog = yield* Backlog
    const entities = yield* Entities
    const models = yield* Models
    const inbox = yield* Inbox
    const files = yield* Files
    const agents = yield* Agents
    const views = yield* Views
    const config = (yield* Config).value as { reasoning?: boolean } | undefined
    let started = false
    const render: Effect.Effect<void, unknown> = Effect.gen(function* () {
      if (!started) {
        started = true
        yield* Effect.ignore(agents.start({ id: "intent", title: "intent", view: "intent", task: "Reconciles the intent's outcomes and constraints into plans on the Backlog." }))
      }
      const v = intentView(a.rounds())
      yield* views.set("intent", IntentView, "summary", { markdown: v.summary })
      yield* views.set("intent", IntentView, "rounds", { rows: v.rows })
      yield* views.set("intent", IntentView, "detail", { markdown: "", rows: v.details })
    }).pipe(Effect.ignore)
    const data = (e: { data: unknown }) => e.data as Data
    const statements = () =>
      Effect.gen(function* () {
        const intents = yield* entities.query({ type: "gherkin/intent" })
        const journeys = yield* entities.query({ type: "gherkin/journey" })
        const out: Array<Statement> = []
        for (const kind of ["outcome", "constraint"] as const)
          for (const e of yield* entities.query({ type: `gherkin/${kind}` })) {
            const i = intents.find((x) => data(x).edges.some((ed) => ed.type === "gherkin/has" && ed.to === e.id))
            if (i === undefined) continue
            const linked = kind === "outcome" ? journeys.filter((j) => data(j).edges.some((ed) => ed.type === "gherkin/serves" && ed.to === e.id)).map((j) => j.id) : data(e).edges.filter((ed) => ed.type === "gherkin/bounds").map((ed) => ed.to).filter((to) => to.startsWith("J-"))
            const problem = data(i).props.problem
            out.push({ id: e.id, kind, text: String(data(e).props.text ?? ""), version: e.version, intent: { id: i.id, title: String(data(i).props.title ?? i.id), ...(typeof problem === "string" ? { problem } : {}) }, journeys: linked })
          }
        return out
      })
    const journeysOf = () =>
      Effect.gen(function* () {
        const listed = yield* gherkin.journeys({})
        const es = yield* entities.query({ type: "gherkin/journey" })
        return listed.map((j): JourneyInfo => {
          const e = es.find((x) => x.id === j.id)
          return { id: j.id, name: j.name, version: e?.version ?? "", scenarios: j.scenarios, serves: e === undefined ? [] : data(e).edges.filter((ed) => ed.type === "gherkin/serves").map((ed) => ed.to) }
        })
      })
    const sceneText = (scenario: string) =>
      Effect.map(gherkin.scene({ scenario }), (s) => {
        const x = s as { title: string; given: string; when: string; thens: ReadonlyArray<string>; ids?: { given: string; thens: ReadonlyArray<string> } } | null
        if (x === null) return `${scenario} (not in the graph)`
        const id = (v: string | undefined) => (v !== undefined ? `  # ${v}` : "")
        return [`${scenario} ${x.title}`, `Given ${x.given}${id(x.ids?.given)}`, `When  ${x.when}`, ...x.thens.map((t, i) => `${i === 0 ? "Then" : "And "}  ${t}${id(x.ids?.thens[i])}`)].join("\n")
      })
    const load = files.read(FILE).pipe(Effect.map((t) => JSON.parse(t) as Checkpoint), Effect.orElseSucceed(() => EMPTY))
    const a = makeIntent(
      {
        statements,
        journeys: journeysOf,
        scene: sceneText,
        code: (scenario) => entities.code(`gherkin/scenario:${scenario}`),
        dryRun: (draft) => gherkin.dryRun({ draft }),
        complete: (req) => models.complete({ role: "driver", ...req }),
        version: (ref) => entities.version(ref),
        plan: (p) => backlog.plan(p as never),
        dropServing: (statement) => backlog.dropServing({ statement }),
        post: (t) => inbox.post(t as never),
        settle: (id, why) => inbox.settle(id, why),
        load,
        save: (cp) => files.write(FILE, `${JSON.stringify(cp, null, 2)}\n`),
        log: (text) => Effect.ignore(agents.step({ id: "intent", text })),
        render,
      },
      config?.reasoning === true,
    )
    return {
      tick: () => Effect.as(a.tick, null),
      answered: ({ key, answer, text }: { id: string; key?: string; answer?: string; text?: string }) =>
        Effect.gen(function* () {
          const notice = key === undefined ? "no key" : yield* a.answered(key, answer, text)
          // A decision makes its statement due: reconcile now, not on the next graph change.
          yield* Effect.forkDetach(Effect.ignore(a.tick))
          return { notice }
        }),
      act: () => Effect.as(render, { notice: "" }),
    }
  }),
})
```
Unused imports fail the typecheck: drop `parseRef` if nothing uses it. Check every power name exists: `grep -n "^export class" packages/plugin-sdk/src/services.ts`. In particular, check `agents.step` takes `{ id, text }` (triage's `log` uses it that way) and `Inbox.post`'s topic shape (Task 3's `Topic` must fit `TopicInput`).

`packages/plugin/scripts/build-plugins.ts:8`: `const FIRST_PARTY = ["plugin-gherkin", "plugin-backlog", "agent-rehearse", "agent-triage", "agent-intent"]`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `mise run build:plugins && cd packages/agent-intent && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS. With no intents the tick asks no model, and the summary reads "No intents yet: nothing to reconcile." (the view renders on the first tick).

- [ ] **Step 6: Commit**

```bash
mise run build:plugins && mise run verify && git add -A packages/agent-intent packages/plugin/scripts/build-plugins.ts packages/plugin/src/server/first-party-hashes.ts && git commit -m "feat(intent): the Intent Agent plugin: its view, checkpoint and inbox answers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The core wakes the Intent Agent when the graph changes

**Files:**
- Create: `packages/core/src/graph-watch.ts`
- Modify: `packages/core/src/live.ts:205-216,255`
- Test: `packages/core/test/graph-watch.test.ts`

**Interfaces:**
- Produces `watchGraph(dir: string, onChange: () => void, quietMs = 1000): { close: () => void }`. It calls `onChange` once per burst of writes under `dir`, after `quietMs` without another write. It does nothing (and does not throw) when `dir` is missing.

- [ ] **Step 1: Write the failing test** (`packages/core/test/graph-watch.test.ts`)

```ts
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchGraph } from "../src/graph-watch"

test("a burst of graph writes wakes once, after it settles; a missing dir is fine", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "zt-watch-")), "graph")
  mkdirSync(join(dir, "nodes"), { recursive: true })
  let woke = 0
  const w = watchGraph(dir, () => void woke++, 100)
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, "nodes", `S-000${i}.json`), "{}")
  await Bun.sleep(400)
  w.close()
  expect(woke).toBe(1)
  expect(() => watchGraph(join(dir, "nope"), () => {}).close()).not.toThrow()
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/core && mise x -- bun test test/graph-watch.test.ts`
Expected: FAIL (the module is not found).

- [ ] **Step 3: Implement**

`graph-watch.ts`:
```ts
import { existsSync, watch } from "node:fs"

/** Calls onChange once per burst of writes under the graph directory, after it has been quiet for quietMs. */
export const watchGraph = (dir: string, onChange: () => void, quietMs = 1000) => {
  if (!existsSync(dir)) return { close: () => {} }
  let timer: ReturnType<typeof setTimeout> | undefined
  const w = watch(dir, { recursive: true }, () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(onChange, quietMs)
  })
  return { close: () => { if (timer !== undefined) clearTimeout(timer); w.close() } }
}
```
`live.ts`, next to `triageTick`:
```ts
    // The Intent Agent: when the graph changes (a statement, a journey), when the backlog's agenda changes (a plan dropped), and once plugins load.
    const intentTick = Effect.suspend(() => (host.manifests.some((m) => m.name === "intent") ? Effect.ignore(host.invoke("intent", "tick", {})) : Effect.void))
```
In `setAgendaChanged`, after the triage line: `if (plugin === "backlog") Effect.runFork(intentTick)`. Next to where the core knows the project root (find the graph dir with `grep -n '".zarg/graph"\|zarg/graph' packages/core/src/live.ts | head -3`), add:
```ts
    const graphWatch = watchGraph(join(root, ".zarg", "graph"), () => void Effect.runFork(intentTick))
    yield* Effect.addFinalizer(() => Effect.sync(() => graphWatch.close()))
```
Use the variable `live.ts` already uses for the project root, and its `join` import. If `live.ts` is not inside a scope (`Effect.addFinalizer` needs `Scope`), close the watcher where the core already closes other resources on stop (`grep -n "close()\|finalizer\|onStop" packages/core/src/live.ts`), and record a ledger ruling. On line 255, chain `intentTick` after `triageTick`: `Effect.andThen(planner.tick, Effect.andThen(triageTick, intentTick))`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/core && mise x -- bun test test/graph-watch.test.ts && mise x -- bunx tsc --noEmit -p . && mise x -- bun test`
Expected: PASS (the core tests too).

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/core && git commit -m "feat(core): a graph change wakes the Intent Agent

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The Intents view shows each statement's plans in flight

**Files:**
- Modify: `packages/plugin-gherkin/src/intents.ts` (`intentsView(snap, plans?)`)
- Modify: `packages/plugin-gherkin/src/index.ts` (scope `entities: { read: ["backlog/item"] }`; `showIntents` reads plans)
- Test: `packages/plugin-gherkin/test/intents.test.ts`

**Interfaces:**
- Produces `intentsView(snap, plans: ReadonlyArray<{ id: string; title: string; status: string; serves: string }> = [])`. A statement's detail gains a `**Plans**` section: `B-12 Backlog: <title>`, for every non-dropped plan whose `serves` names the statement.

- [ ] **Step 1: Write the failing test** (append inside `describe("the Intents view", …)` in `intents.test.ts`)

```ts
  test("a statement's detail lists the plans serving it, by lane", () => {
    const v = intentsView(s, [{ id: "B-12", title: "Shorten pricing", status: "backlog", serves: "gherkin/outcome:O-0002@abcdefabcdef" }, { id: "B-13", title: "Other", status: "ready", serves: "gherkin/outcome:O-0009@abcdefabcdef" }])
    expect(v.details["O-0002"]).toContain("**Plans**\n- B-12 backlog: Shorten pricing")
    expect(v.details["O-0001"]).not.toContain("B-13")
  })
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/plugin-gherkin && mise x -- bun test test/intents.test.ts -t "plans serving"`
Expected: FAIL. The detail has no Plans section.

- [ ] **Step 3: Implement**

In `intents.ts`, change the signature to `intentsView = (snap, plans: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string; readonly serves: string }> = [])`. After computing each statement's `details[s.id]`, append:
```ts
      const mine = plans.filter((p) => p.serves.split("@")[0] === `${s.type}:${s.id}`)
      if (mine.length > 0) details[s.id] += `\n\n**Plans**\n${mine.map((p) => `- ${p.id} ${p.status}: ${p.title}`).join("\n")}`
```
`serves` is `gherkin/outcome:O-0002@v`, and `s.type` is `gherkin/outcome`, so compare as written.

In `index.ts`:
- add `entities: { read: ["backlog/item"] }` to `scopes`;
- in `showIntents`, read the plans when the backlog is there:
```ts
      const items = yield* entities_.query({ type: "backlog/item" }).pipe(Effect.orElseSucceed(() => []))
      const plans = items.flatMap((e) => { const d = e.data as { title?: string; status?: string; serves?: string; dropped?: boolean }; return d.serves !== undefined && d.dropped !== true ? [{ id: e.id, title: String(d.title ?? e.id), status: String(d.status ?? ""), serves: d.serves }] : [] })
      const v = intentsView(yield* snap, plans)
```
Without the backlog plugin, `query` fails with `UnknownType` and the view simply shows no plans.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/plugin-gherkin && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/plugin-gherkin && git commit -m "feat(gherkin): the Intents view shows the plans serving each statement

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Live reconcile of I-0001, then a strict audit

The model runs here. **Stop and ask the operator before Step 1.** It uses the driver model, and the operator runs their own core.

**Files:**
- Modify: `packages/audit/src/index.ts` (warnings become problems)
- Modify: `packages/audit/test/audit.test.ts`
- Docs: `AGENTS.md`, `docs/taxonomy.md`

- [ ] **Step 1: Ask the operator**

Ask the operator to restart their core (`zarg core stop`, then their usual start) so it loads the `intent` plugin, grant it, and let it reconcile I-0001. They then review the plans it files in the Backlog (`serves` links for J-0001..5 and scenario changes for uncovered outcomes), move the ones they accept to Ready, and answer its inbox topics. Wait for them to say it is done.

- [ ] **Step 2: Check the graph is covered**

Run: `mise run -q zarg -- audit --summary | tail -1`
Expected: the line ends without `uncovered`/`unserving` counts (no warnings). If warnings remain, show them to the operator and wait: each one is theirs to answer (a journey to add, an outcome to drop). Do not continue while any remain.

- [ ] **Step 3: Write the failing test**

In `packages/audit/test/audit.test.ts`, change the first `intent coverage` test's expectations:
```ts
    expect(r.problems).toEqual([{ kind: "uncovered", outcome: "O-0002", text: "outcome O-0002" }, { kind: "unserving", journey: "J-0002", name: "journey J-0002" }])
    expect(summary(r).split("\n").at(-1)).toBe("0 built · 0 planned · 0 untagged · 0 planned-but-tagged · 0 orphan · 1 uncovered · 1 unserving")
```
and remove its `r.warnings` line.

- [ ] **Step 4: Run it and watch it fail**

Run: `cd packages/audit && mise x -- bun test`
Expected: FAIL (`problems` is `[]`).

- [ ] **Step 5: Implement**

In `packages/audit/src/index.ts`:
- fold the `Warning` kinds into `Problem`: `| { readonly kind: "uncovered"; readonly outcome: string; readonly text: string } | { readonly kind: "unserving"; readonly journey: string; readonly name: string }`;
- return them in `problems` after the tag problems, and drop `warnings` from `Report`;
- in `summary`, print the two kinds with the same lines as before, and use `count` for the suffix: ` · ${count("uncovered")} uncovered · ${count("unserving")} unserving` whenever either is non-zero.

`grep -rn "warnings" packages/audit packages/cli` must then find nothing. In the `auditCmd` docstring, drop "(warnings never fail it)".

Docs: in `docs/taxonomy.md`, the Audit row loses "warnings until every journey serves an outcome". In `AGENTS.md`, the audit bullet adds `uncovered` and `unserving` to the problems it fails on.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `cd packages/audit && mise x -- bun test && cd ../cli && mise x -- bunx tsc --noEmit -p . && cd ../.. && mise run -q zarg -- audit --summary; echo "exit=$?"`
Expected: PASS, and `exit=0` over the repo's graph.

- [ ] **Step 7: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/audit packages/cli docs/taxonomy.md AGENTS.md && git commit -m "feat(audit): every outcome served, every journey serving one

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:**
  - "What starts a round": changed, new or uncovered statements and unserving journeys (Task 3 `due`), with the checkpoint at `.zarg/intent/checkpoint.json` (Task 4).
  - "What a round does":
    - 1: context with code (Task 3 `contextOf`);
    - 2: driver model, no reasoning, dry-run (Task 3);
    - 3: fold into plans with `serves` (Tasks 1, 2, 3);
    - 4: inbox for undecided cases (Task 3 asks; Task 4 `answered`).
  - "After a round": the checkpoint moves (Task 3).
  - Guards:
    - drafts never touch the graph: plans only (Task 3);
    - a statement that changed again: Task 3;
    - a removed statement's plans dropped: Tasks 2 and 3.
  - Migration's serves links: Task 7 (rounds over unserving journeys, Task 3). Strict audit: Task 7.
  - The Intent view's "plans in flight": Task 6.
  - Wake: Task 5.
- **Rulings made here (deviations from the spec's words):**
  - The agent runs one round at a time with no worker pool. The spec says both "rounds one at a time" and "has workers like triage", and one at a time keeps model spend bounded. Cost if wrong: a later worker pool, as triage has.
  - The fold uses dependency components with no model grouping or atomic check. A statement's round is small, and the model call per group is triage's cost. Cost if wrong: plans group less by concept.
  - An unserving journey's round files one plan of `serves` links (the operator confirms by moving it to Ready), and asks the inbox only when no outcome fits. Cost if wrong: the operator approves links on the board, not in the inbox.

---
