# Fold Triage Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A triage round ends in several small plans on the Backlog, ordered by what they need from each other, instead of one plan.

**Architecture:** The backlog gains `plans` (file a round's plans with `after` links) and learns that a plan's dependencies change its cards by design. `agent-triage` gains `fold.ts`, a pure fold of a round's units (one per drafted card) into ordered groups; the worker wraps it with the driver model (concept groups), the decision model (atomic check), and dry-runs.

**Tech Stack:** Bun, Effect 4, the plugin SDK (`Models`, `Decisions`, contracts), gherkin's `dryRun`.

**Spec:** `docs/superpowers/specs/2026-09-29-fold-triage-plans-design.md`

## Global Constraints

- At most 5 cards per plan.
- Plans land in the Backlog lane; the Planner still takes only Ready plans whose `after` plans are Done.
- The model's answer is advice: structure (dependencies, cycles, dry-runs) always wins.
- Decisions unavailable: groups are taken as atomic (the cap still applies).
- `mise run build:plugins && mise run verify` before each commit.

## Review Focus

1. A round of one card: one plan, no `after`, as today. → Task 3 test "a round of one card".
2. The model groups a card twice, or leaves one out: every unit lands in exactly one plan. → Task 2 test "groups repaired".
3. A dependency on a dropped plan: the dependent shows `(dropped)` and the Planner does not take it. → Task 1 test "a dropped dependency blocks".
4. A plan waits on one whose cards it shares: no ⚠ for those cards. → Task 1 test "cards its dependencies touch".
5. A later plan that does not dry-run with its dependencies: merged, the fold still covers every unit. → Task 2 test "a plan that fails its dry-run merges".

---

### Task 1: The backlog files a round's plans

**Files:**
- Modify: `packages/plugin-backlog/src/contract.ts`, `src/index.ts`, `src/items.ts`, `src/stages.ts`, `src/plan-text.ts`
- Test: `packages/plugin-backlog/test/backlog.test.ts`, `test/items.test.ts`

**Interfaces:**
- Produces: contract method `plans({ journey: string, plans: Array<{ title, steps: string[], changes: Draft, cards: string[] (card ids), feedback: string[] (entry ids), after: number[] (indexes) }> }) → { ids: string[] }`. Stage field `items?: string[]` (the round's plans); `item` kept for old stages.
- `waitingOn(item, all)` now counts a dropped dependency as waiting; `blockedBy(item, all) → { waits: string[], dropped: string[] }`.
- `changedRefs` / `pickNext` ignore a plan's card when a plan in its `after` lists the same card.

- [ ] **Step 1: Write the failing tests** (`test/backlog.test.ts`, inside `describe("the backlog's plans")`)

```ts
test("plans: a round's plans in Backlog, after linked by id, feedback split, the journey planned until the last goes", async () => {
  const out = await run((seen) => Effect.gen(function* () {
    const { card, feedback } = yield* setUp
    const h = yield* PluginHost
    const change = planOf(card.ref, feedback).changes
    const r = (yield* h.invoke("backlog", "plans", { journey: "Set up", plans: [
      { title: "First", steps: ["a"], changes: change, cards: ["UX-0001"], feedback, after: [] },
      { title: "Second", steps: ["b"], changes: change, cards: ["UX-0001"], feedback: [], after: [0] },
    ] })) as { ids: string[] }
    const items = yield* Effect.forEach(r.ids, (id) => Effect.map(h.entities.get(`backlog/item:${id}`), (e) => e.data as { status: string; after?: string[] }))
    const stage = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; items?: string[] }>)[0]!
    yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: [r.ids[0]!] })
    yield* h.invoke("backlog", "act", { agent: "backlog", action: "drop", rows: [] })
    const afterDrop = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string }>)[0]!.stage
    yield* h.invoke("backlog", "act", { agent: "backlog", action: "open", rows: [] })
    const second = lanes(seen).backlog!.find((c) => c.id === r.ids[1])!
    return { ids: r.ids, items, stage, afterDrop, second: second.lines.map((l) => l.text) }
  }))
  expect(out.ids).toEqual(["B-01", "B-02"])
  expect(out.items.map((i) => [i.status, i.after ?? []])).toEqual([["backlog", []], ["backlog", ["B-01"]]])
  expect([out.stage.stage, out.stage.items]).toEqual(["planned", ["B-01", "B-02"]])
  expect(out.afterDrop).toBe("planned")
  expect(out.second).toContain("⇠ after B-01 (dropped)")
})
test("cards its dependencies touch are not changed for it: no ⚠, and the Planner takes it once they are Done", async () => {
  const out = await run((seen) => Effect.gen(function* () {
    const { card, feedback } = yield* setUp
    const h = yield* PluginHost
    const change = planOf(card.ref, feedback).changes
    yield* h.invoke("backlog", "plans", { journey: "Set up", plans: [
      { title: "First", steps: [], changes: change, cards: ["UX-0001"], feedback, after: [] },
      { title: "Second", steps: [], changes: [], cards: ["UX-0001"], feedback: [], after: [0] },
    ] })
    // The first is applied: the card changes.
    yield* gherkin("edit-card", { id: "UX-0001", when: "the plugin needs a scope it may ask for" })
    for (const id of ["B-01", "B-02"]) yield* h.invoke("backlog", "moved", { id, to: "ready", by: "operator" })
    yield* h.invoke("backlog", "moved", { id: "B-01", to: "done", by: "operator" })
    const next = (yield* h.invoke("backlog", "next", {})) as { id: string } | null
    yield* h.invoke("backlog", "act", { agent: "backlog", action: "open", rows: [] })
    return { next: next?.id, lines: lanes(seen).ready!.find((c) => c.id === "B-02")!.lines.map((l) => l.text) }
  }))
  expect(out.next).toBe("B-02")
  expect(out.lines).not.toContain("⚠ card changed")
})
```

- [ ] **Step 2: Run** `cd packages/plugin-backlog && mise x -- bun test test/backlog.test.ts` — Expected: both FAIL (`plans` unknown).

- [ ] **Step 3: Implement**
  - `contract.ts`: `PlansParams = Schema.Struct({ journey, plans: Schema.Array(Schema.Struct({ title, steps: Schema.Array(Schema.String), changes: DraftCalls, cards: Schema.Array(Schema.String), feedback: Schema.Array(Schema.String), after: Schema.Array(Schema.Number) })) })`; add `plans: { params: PlansParams, success: Schema.Struct({ ids: Schema.Array(Schema.String) }) }` to `Backlog`; `StageData` gains `items: Schema.optionalKey(Schema.Array(Schema.String))`.
  - `stages.ts`: `Stage.items?: ReadonlyArray<string>`.
  - `index.ts` `plans` handler: under `planning`, for each plan in order: card refs at their versions now (`entities.version(gherkin/card:<id>)`), `plan({ title, journey, cards, changes, feedback, steps, after: after.map((k) => ids[k]!) })`; then `updateStage(journey, (x) => ({ ...x, stage: "planned", items: ids }))`; return `{ ids }`.
  - `drop`: reset the journey only when every id in its stage's `items ?? [item]` is dropped.
  - `items.ts`: `waitingOn` keeps dropped dependencies (`x !== undefined && x.status !== "done"`), and `boardCard` writes `⇠ after B-01 (dropped)` for a dropped one; `pickNext` unchanged otherwise (a dropped dependency waits forever).
  - `index.ts` `changedRefs(items)`: a ref counts as changed for an item only when no item in its `after` lists the same card (`target(ref)`); return a `(item, ref) => boolean` or compute per item in `refreshBoard`/`next`.
  - `plan-text.ts`: add a line `Waits on B-01 · B-03 waits on this` from the item's `after` and the items whose `after` names it (pass both lists in).

- [ ] **Step 4: Run** the package tests — Expected: PASS (all).

- [ ] **Step 5: Commit** `feat(backlog): a triage round's plans filed together, after-linked; a dependency's cards are not 'changed' for what waits on it; a dropped dependency blocks`.

### Task 2: `fold.ts`: a round folded into ordered groups

**Files:**
- Create: `packages/agent-triage/src/fold.ts`
- Test: `packages/agent-triage/test/fold.test.ts`

**Interfaces:**
- Produces:
  - `type Unit = { card: string; title: string; summary: string; changes: Draft; answers: string[] }`
  - `dependencies(units): Array<[number, number]>` — `[b, a]`: unit b (later) depends on unit a.
  - `fold(units, deps, groups?: Array<{ title: string; steps: string[]; cards: string[] }>, atomic?: (g) => boolean): Array<{ title; steps; units: number[]; after: number[] }>` — groups repaired (each unit once, unknown/missing units into their own group), cycles merged, split at 5 cards in draft order, `after` between groups; without `groups`: dependency components.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { dependencies, fold, type Unit } from "../src/fold"

const u = (card: string, changes: Unit["changes"]): Unit => ({ card, title: card, summary: `fix ${card}`, changes, answers: [] })
const units = [
  u("UX-0001", [{ tool: "edit-state", params: { id: "S-0002", text: "asked once" } }, { tool: "link", params: { card: "UX-0001", edge: "then", state: { text: "a new state" } } }]),
  u("UX-0002", [{ tool: "link", params: { card: "UX-0002", edge: "then", state: { text: "a new state" } } }]),
  u("UX-0003", [{ tool: "edit-card", params: { id: "UX-0003", when: "it runs" } }]),
  u("UX-0004", [{ tool: "edit-state", params: { id: "S-0002", text: "asked twice" } }]),
]

describe("folding a round", () => {
  test("dependencies: a later unit naming what an earlier one created or changed", () => {
    expect(dependencies(units)).toEqual([[1, 0], [3, 0]])
  })
  test("the model's groups, ordered: a group waits on the group its units depend on", () => {
    const plans = fold(units, dependencies(units), [
      { title: "States", steps: ["s"], cards: ["UX-0001", "UX-0004"] },
      { title: "Links", steps: ["l"], cards: ["UX-0002"] },
      { title: "When", steps: ["w"], cards: ["UX-0003"] },
    ])
    expect(plans.map((p) => [p.title, p.units, p.after])).toEqual([["States", [0, 3], []], ["Links", [1], [0]], ["When", [2], []]])
  })
  test("groups repaired: a card twice or left out still lands in exactly one plan", () => {
    const plans = fold(units, dependencies(units), [{ title: "A", steps: [], cards: ["UX-0001", "UX-0002"] }, { title: "B", steps: [], cards: ["UX-0002"] }])
    expect(plans.flatMap((p) => p.units).sort()).toEqual([0, 1, 2, 3])
  })
  test("plans that would wait on each other merge", () => {
    const plans = fold(units, [[1, 0], [0, 1]], [{ title: "A", steps: [], cards: ["UX-0001"] }, { title: "B", steps: [], cards: ["UX-0002"] }])
    expect(plans.find((p) => p.units.includes(0))!.units).toEqual([0, 1])
  })
  test("at most 5 cards a plan, split in draft order", () => {
    const many = Array.from({ length: 7 }, (_, i) => u(`UX-01${i}`, []))
    expect(fold(many, [], [{ title: "All", steps: [], cards: many.map((x) => x.card) }]).map((p) => p.units.length)).toEqual([5, 2])
  })
  test("without the model: the dependency components", () => {
    expect(fold(units, dependencies(units)).map((p) => p.units)).toEqual([[0, 1, 3], [2]])
  })
  test("a group judged not atomic splits into its dependency components", () => {
    const plans = fold(units, dependencies(units), [{ title: "All", steps: [], cards: units.map((x) => x.card) }], () => false)
    expect(plans.map((p) => p.units)).toEqual([[0, 1, 3], [2]])
  })
})
```

- [ ] **Step 2: Run** `cd packages/agent-triage && mise x -- bun test test/fold.test.ts` — Expected: FAIL (no module).

- [ ] **Step 3: Implement `fold.ts`**
  - `names(change)`: the node ids and new state texts a change names: `params.id`, `params.card`, `params.state.id`, `params.state.text`, `params.arrives.id|text`, each `params.then[].id|text`; plus for `add-card` its title (a new card).
  - `made(change)`: what it creates or changes: `edit-state` → `params.id`; `edit-card` → `params.id`; `link`/`unlink` → `params.card` and a `state.text`; `add-card` → its title, `arrives.text`, each `then[].text`; `add-state` → `params.text`.
  - `dependencies`: for each later unit b and earlier unit a, b depends on a when any name of b is in a's made set.
  - `fold`: map each card to one group (first wins; unknown cards dropped; missing units each alone), group index by first unit; merge groups in a cycle (union-find over group-level edges both ways); for a group `atomic(g) === false` with more than one unit, replace it by its dependency components; split groups over 5 units in draft order; order groups by their first unit; `after` = groups holding units the group's units depend on.
  - Components (no `groups`): union-find over `deps`, in draft order.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat(triage): fold a round's drafted cards into ordered groups (dependencies from what changes create and name; cycles merged; at most 5 cards; components without the model)`.

### Task 3: The worker folds a round into plans

**Files:**
- Modify: `packages/agent-triage/src/triage.ts`, `src/index.ts`
- Test: `packages/agent-triage/test/triage.test.ts`

**Interfaces:**
- Consumes: `dependencies`, `fold` (Task 2); backlog `plans` (Task 1).
- Produces: `TriageDeps.decide(req) → answers` and `TriageDeps.plans(journey, plans)`; the worker's Plan step calls `plans` instead of `drafted`.

- [ ] **Step 1: Write the failing tests** (in `describe("the Triage Agent")`)

```ts
test("a round ends in folded plans: the model's concepts, checked atomic, ordered, each dry-run with what it waits on", async () => {
  const accepted = (card: string, changes: unknown[]) => ({ card, title: card, changes, answers: [], summary: `fix ${card}`, status: "accepted" })
  const round = stage({ stage: "plan", draft: [{ tool: "edit-state", params: { id: "S-0002", text: "x" } }], proposals: [accepted("UX-0001", [{ tool: "edit-state", params: { id: "S-0002", text: "x" } }]), accepted("UX-0002", [{ tool: "edit-card", params: { id: "UX-0002", when: "y" } }])] })
  const { t, calls } = setup({ stages: [round], answers: [JSON.stringify({ groups: [{ title: "Name the choices", steps: ["one"], cards: ["UX-0001"] }, { title: "Say when", steps: ["two"], cards: ["UX-0002"] }] })] })
  await Effect.runPromise(t.tick)
  const filed = calls.find(([k]) => k === "plans")?.[1] as { journey: string; plans: Array<{ title: string; cards: string[]; after: number[] }> }
  expect(filed.journey).toBe("Set up")
  expect(filed.plans.map((p) => [p.title, p.cards, p.after])).toEqual([["Name the choices", ["UX-0001"], []], ["Say when", ["UX-0002"], []]])
  expect(calls.find(([k]) => k === "drafted")).toBeUndefined()
})
test("a round of one card: one plan, no after", async () => {
  const round = stage({ stage: "plan", draft: [{ tool: "edit-state", params: {} }], proposals: [{ card: "UX-0001", title: "c", changes: [{ tool: "edit-state", params: {} }], answers: [], summary: "s", status: "accepted" }] })
  const { t, calls } = setup({ stages: [round], answers: [JSON.stringify({ groups: [{ title: "T", steps: [], cards: ["UX-0001"] }] })] })
  await Effect.runPromise(t.tick)
  expect((calls.find(([k]) => k === "plans")?.[1] as { plans: unknown[] }).plans.length).toBe(1)
})
test("no model answer: the fold's structure alone; a group the decision model finds not atomic splits", async () => {
  const accepted = (card: string, changes: unknown[]) => ({ card, title: card, changes, answers: [], summary: `fix ${card}`, status: "accepted" })
  const round = stage({ stage: "plan", draft: [{ tool: "edit-card", params: {} }], proposals: [accepted("UX-0001", [{ tool: "edit-card", params: { id: "UX-0001" } }]), accepted("UX-0002", [{ tool: "edit-card", params: { id: "UX-0002" } }])] })
  const none = setup({ stages: [round], answers: ["no json"] })
  await Effect.runPromise(none.t.tick)
  expect((none.calls.find(([k]) => k === "plans")?.[1] as { plans: unknown[] }).plans.length).toBe(2)
  const split = setup({ stages: [round], answers: [JSON.stringify({ groups: [{ title: "Both", steps: [], cards: ["UX-0001", "UX-0002"] }] })], atomic: false })
  await Effect.runPromise(split.t.tick)
  expect((split.calls.find(([k]) => k === "plans")?.[1] as { plans: unknown[] }).plans.length).toBe(2)
})
```

  The `setup` helper gains `atomic?: boolean` (default true) and stubs: `decide: () => Effect.succeed(Object.fromEntries(["single", "oneExecutor", "noSteps", "noPackaging", "noCoordination"].map((k) => [k, { answer: o.atomic ?? true, confidence: 0.9 }])))`, `plans: (journey, plans) => Effect.sync(() => void calls.push(["plans", { journey, plans }]))`.

- [ ] **Step 2: Run** `mise x -- bun test test/triage.test.ts` — Expected: the three FAIL.

- [ ] **Step 3: Implement**
  - `triage.ts`: `TriageDeps.decide` and `TriageDeps.plans`. Replace the Plan step's `draftPlan(after, …)` with `foldRound(after, who)`:
    1. units = accepted proposals (draft order) → `{ card, title, summary, changes, answers }`;
    2. deps = `dependencies(units)`;
    3. ask the driver (no reasoning, as other asks) with the units and deps for `{"groups":[{"title","steps","cards"}]}` (JSON only); parse with `jsonIn`;
    4. `atomic(g)`: for groups over one unit, `d.decide({ state: <the group's cards and summaries>, questions: <the five ROMA criteria as { type: "noul", instructions } > })`; atomic when every answer is true with confidence ≥ 0.6; Decisions failing → atomic;
    5. plans = `fold(units, deps, groups, atomic)` (the async atomic answers computed first into a map keyed by group cards);
    6. dry-run each plan with the plans it waits on applied first (their changes, then its own); one that fails merges into the plan it waits on (or the previous plan), and the plans are dry-run again (at most as many passes as plans);
    7. `d.plans(journey, plans.map((p) => ({ title, steps, changes: units' changes, cards: units' cards, feedback: units' answers plus on-card feedback ids from `feedbackOf`, after })))`; log `"<journey>: folded into N plans: <titles>"`.
  - `index.ts`: scopes `decisions: true`; wire `decide: (req) => decisions.decide(req)` (`yield* Decisions`) and `plans: (journey, plans) => Effect.asVoid(backlog.plans({ journey, plans }))`.

- [ ] **Step 4: Run** the package tests — Expected: PASS (the old Plan-step tests that expected `drafted` are updated to expect `plans`).

- [ ] **Step 5:** `mise run build:plugins && mise run verify` — Expected: PASS. AGENTS.md: the agent-triage line says a round ends in folded plans (concepts, atomic check, at most 5 cards, `after`); the backlog line says a round's plans are linked and a dependency's cards are not ⚠ for what waits on it. Commit `feat(triage): a round ends in folded plans (the model's concepts, checked atomic by the decision model, at most 5 cards, ordered by what they need), not one mega plan`.
