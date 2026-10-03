# Intents in the Graph (a): Model, Tools, Agenda, Audit, View, Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Intents become graph nodes in `plugin-gherkin` (intent `I-`, outcome `O-`, constraint `K-`, question `Q-`, with `has`, `for`, `serves` and `bounds` edges), with tools, lints, agenda items, audit warnings, render, an Intents nav view, and `intent/zarg.md` migrated into the graph as I-0001.

**Architecture:** Every new node kind and edge lives in `plugin-gherkin`, beside scenarios and journeys, and every write goes through the host's write pipeline. The host's edge spec learns one thing: an edge can point at several node types. The Intents view writes through `Entities.command` on gherkin's own kinds, so the operator's edits go through the same lints and checks as a `zarg tool call`. Plan (b), `2026-10-03-intents-agent.md`, builds the intent agent on top of this.

**Tech Stack:** Bun, Effect 4 (`effect` Schema), `@zarg/plugin-sdk` (`definePlugin`, `defineView`, `Entities`, `Views`), `@zarg/graph/pure` (`Snapshot`, `Put`, `Remove`), bun test.

**Spec:** `docs/superpowers/specs/2026-10-02-intents-in-the-graph-design.md` (terms: `docs/taxonomy.md`)

## Global Constraints

- `mise run build:plugins && mise run verify` passes before every commit (verify typechecks, tests every package, and runs `zarg audit`).
- Run tools through mise: `mise x -- bun test`, never a bare `bun`; never `npm`/`npx`/`node`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Ids: intent `I-0001`, outcome `O-0001`, constraint `K-0001`, question `Q-0001`. Edges: `gherkin/has` (intent → outcome, constraint or question; each statement exactly one intent), `gherkin/for` (intent → persona), `gherkin/serves` (journey → outcome, many to many), `gherkin/bounds` (constraint → journey or scenario).
- Words (taxonomy): "outcome", never "goal"; "scenario", never "card" (a card is only an agent's grid tile or a kanban plan); a scenario's result lines are its "Then", never its "outcome"; the person is "the operator".
- Statement text: one sentence, at most 20 words, no "if". An intent title: at most 10 words.
- `.zarg/graph` changes only through `zarg tool call` (or the host's write pipeline). Never edit node files by hand.
- Don't start a zarg core in the repo root (the operator runs their own); tests use temp dirs.
- `uncovered` and `unserving` are audit **warnings** in this plan: `verify` stays green until plan (b) links journeys to outcomes.

## Review Focus

1. **The view writes through its own plugin.** gherkin's `act` calls `Entities.command` on a gherkin kind, which the host routes back into gherkin's tool method while `act` is still running. Expected: the write lands and `act` answers. It must not deadlock or time out. Task 7 adds a host-level test for exactly this.
2. **Removing a statement a journey serves.** The generic `remove` refuses a node with inbound edges, but every statement has an inbound `has`. Expected: `remove O-…` drops the `has` and `serves` edges pointing at it and removes it. Removing an intent that still has statements is refused, with the statements named. Task 3 tests both.
3. **A statement with zero intents or two.** This happens when a write moves or drops a `has` edge. Expected: the `statement-owner` lint refuses the write and names the statement and its intents. Task 4 tests it.
4. **Agenda flood.** 16 uncovered outcomes and 5 unserving journeys must not become 21 separate driver agenda items. Expected: one grouped item for each, like the existing `who-does`. Task 5 tests it.
5. **Projects with no intents.** A graph without outcomes must not report every journey as "unserving", either on the agenda or in the audit. Task 5 and Task 6 test it.

---

## File Structure

- Modify `packages/plugin/src/server/plugin.ts` and `packages/plugin-sdk/src/define.ts`: `EdgeSpec.to` becomes `string | ReadonlyArray<string>`.
- Modify `packages/plugin/src/server/validate.ts`: the registry resolves `to` as a list; the edge-target check accepts any type in it.
- Modify `packages/plugin-gherkin/src/model.ts`: the new node types, edge types, props schemas and helpers.
- Create `packages/plugin-gherkin/src/intent-tools.ts`: the add, edit and answer tools for intents and statements.
- Modify `packages/plugin-gherkin/src/tools.ts`: `link` and `unlink` handle `serves`, `bounds` and `for`; `remove` handles statements and intents; `tools` includes the intent tools.
- Modify `packages/plugin-gherkin/src/lints.ts`: statement clauses (20 words), `intentShape`, `statementOwner`, and a `LINTS` list.
- Modify `packages/plugin-gherkin/src/agenda.ts`: intent items.
- Modify `packages/plugin-gherkin/src/render.ts`: `renderIntent`, and `render` with intents in focus.
- Create `packages/plugin-gherkin/src/intents.ts`: `intentsView(snap)`, the view's pure data.
- Modify `packages/plugin-gherkin/src/views.ts`: `IntentsView`.
- Modify `packages/plugin-gherkin/src/index.ts`: props, graph nodes and edges, entities with commands, the `intents` nav surface, and `act` for the Intents view.
- Modify `packages/audit/src/index.ts` and `packages/cli/src/commands.ts`: `warnings` (`uncovered`, `unserving`).
- Modify `packages/agent-zarg/src/intent.ts` and `packages/agent-zarg/src/zarg.ts`: "what next" from uncovered outcomes.
- Modify `packages/agent-rehearse/src/index.ts`: drop the `intent/**` read scope.
- Delete `intent/zarg.md` once its content is in the graph.
- Tests: `packages/plugin/test/validate.test.ts`, `packages/plugin-gherkin/test/intents.test.ts` (new), `packages/audit/test/audit.test.ts`, `packages/agent-zarg/test/intent.test.ts`.
- Docs: `AGENTS.md`, `.claude/skills/zarg-drive/SKILL.md`, `docs/taxonomy.md`, the spec's view keys.

---

### Task 1: An edge can point at several node types

**Files:**
- Modify: `packages/plugin/src/server/plugin.ts:5-10`
- Modify: `packages/plugin-sdk/src/define.ts:47`
- Modify: `packages/plugin/src/server/validate.ts:24-29,56-80`
- Test: `packages/plugin/test/validate.test.ts`

**Interfaces:**
- Produces: `EdgeSpec { from: string; to: string | ReadonlyArray<string>; min?: number; max?: number }`. A finding for a wrong target now says `must point to a <t1> or <t2>`.

- [ ] **Step 1: Write the failing test** (append to `packages/plugin/test/validate.test.ts`)

```ts
describe("an edge to several node types", () => {
  const tags = { name: "tags", graph: { nodes: { tag: {}, note: {}, topic: {}, other: {} }, edges: { on: { from: "tag", to: ["note", "topic"] } } } }
  const reg2 = manifestRegistry([tags])
  const check2 = (nodes: ReadonlyArray<Node>) => {
    const after = Snapshot.make(nodes)
    return checkStructure(reg2, { before: Snapshot.empty, after, diff: diff(Snapshot.empty, after) })
  }
  const node = (id: string, type: string, edges: Node["edges"] = []): Node => ({ id, type: `tags/${type}`, props: {}, edges })
  test("it may point at any of them", () => {
    expect(check2([node("N-1", "note"), node("T-1", "topic"), node("G-1", "tag", [{ type: "tags/on", to: "N-1" }, { type: "tags/on", to: "T-1" }])])).toEqual([])
  })
  test("any other type is a wrong target, naming every allowed one", () => {
    const found = check2([node("X-1", "other"), node("G-1", "tag", [{ type: "tags/on", to: "X-1" }])])
    expect(found.map((f) => f.code)).toEqual(["edge-target"])
    expect(found[0]!.message).toBe('G-1: "tags/on" must point to a tags/note or tags/topic, X-1 is a tags/other')
  })
  test("an unknown type in the list is refused at registration", () => {
    expect(() => manifestRegistry([{ name: "x", graph: { nodes: { a: {} }, edges: { e: { from: "a", to: ["a", "b"] } } } }])).toThrow('unknown node type "x/b"')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/plugin && mise x -- bun test test/validate.test.ts`
Expected: FAIL. The typecheck or the runtime rejects an array `to`: the first test reports `edge-target`, and the unknown-type test does not throw.

- [ ] **Step 3: Implement**

`packages/plugin/src/server/plugin.ts`:
```ts
/** Edge cardinality between two of the plugin's node types (local names, e.g. "scenario"); `to` may name several. */
export interface EdgeSpec {
  readonly from: string
  readonly to: string | ReadonlyArray<string>
  readonly min?: number
  readonly max?: number
}
```

`packages/plugin-sdk/src/define.ts:47`:
```ts
export interface EdgeSpec { readonly from: string; readonly to: string | ReadonlyArray<string>; readonly min?: number; readonly max?: number }
```

`packages/plugin/src/server/validate.ts`. The registry stores `to` as a list:
```ts
/** An edge spec with full type names; `to` is always a list. */
export interface ResolvedEdge { readonly from: string; readonly to: ReadonlyArray<string>; readonly min?: number; readonly max?: number }
export interface ManifestRegistry {
  /** Full node type ("notes/topic") → the plugin that owns it. */
  readonly nodes: ReadonlyMap<string, string>
  readonly edges: ReadonlyMap<string, ResolvedEdge>
}
```
In `manifestRegistry`, replace the resolution loop body:
```ts
    for (const [local, spec] of Object.entries(m.graph?.edges ?? {})) {
      const to = (typeof spec.to === "string" ? [spec.to] : spec.to).map((t) => full(m.name, t))
      const resolved: ResolvedEdge = { ...spec, from: full(m.name, spec.from), to }
      for (const t of [resolved.from, ...to]) {
        if (!nodes.has(t)) throw new PluginConfigError(`edge "${m.name}/${local}" uses unknown node type "${t}"`)
      }
      edges.set(`${m.name}/${local}`, resolved)
    }
```
Declare `const edges = new Map<string, ResolvedEdge>()`. In `checkNode`, replace the target check:
```ts
    const target = ctx.after.nodes.get(edge.to)
    if (target !== undefined && !spec.to.includes(target.type)) {
      out.push(error("edge-target", `${node.id}: "${edge.type}" must point to a ${spec.to.join(" or ")}, ${edge.to} is a ${target.type}`, [node.id, edge.to]))
    }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/plugin && mise x -- bun test test/validate.test.ts && mise x -- bunx tsc --noEmit -p .`
Expected: PASS. The old test "edge pointing at the wrong node type" still passes, with the message `must point to a notes/topic`.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/plugin packages/plugin-sdk && git commit -m "feat(plugin): an edge may point at several node types

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Intent and statement nodes, edges and entities

**Files:**
- Modify: `packages/plugin-gherkin/src/model.ts` (append)
- Modify: `packages/plugin-gherkin/src/index.ts` (PROPS, EDGES, `graph.nodes`, `entities`, entity handlers)
- Test: `packages/plugin-gherkin/test/intents.test.ts` (new)

**Interfaces:**
- Consumes: `EdgeSpec.to` as a list (Task 1).
- Produces, from `model.ts`:
  - constants `INTENT`, `OUTCOME`, `CONSTRAINT`, `QUESTION`, `HAS`, `FOR`, `SERVES`, `BOUNDS`, `STATEMENT_TYPES: ReadonlyArray<string>`;
  - schemas `IntentProps`, `StatementProps`, `QuestionProps`;
  - `intents(snap)`;
  - `statementsOf(snap, intentId): ReadonlyArray<Node>` (its `has` targets, in edge order);
  - `intentOf(snap, statementId): string | undefined`;
  - `servedBy(snap, outcomeId): ReadonlyArray<string>` (journey ids, sorted);
  - `isStatement(n: Node): boolean`.
- Produces entity kinds `gherkin/intent`, `gherkin/outcome`, `gherkin/constraint` and `gherkin/question`, labelled by title or text and versioned by node hash (the host's default).

- [ ] **Step 1: Write the failing test** (`packages/plugin-gherkin/test/intents.test.ts`)

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GraphStore } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { call, run } from "./harness"

/** A refusal's words: the tool's message, or every lint finding's. */
const said = (e: { readonly _tag: string; readonly message?: string; readonly findings?: ReadonlyArray<{ readonly message: string }> }) =>
  e._tag === "LintFailed" ? (e.findings ?? []).map((f) => f.message).join("\n") : String(e.message ?? e)

/** Nodes as stored, written directly through the store (a graph a tool could not make, to test checks). */
const put = (nodes: ReadonlyArray<unknown>) => GraphStore.use((g) => g.commit(nodes.map((node) => ({ _tag: "Put", node })) as never))

describe("intent nodes", () => {
  test("an intent and its statements are entities: labelled by title or text, versioned", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* put([
          { id: "I-0001", type: "gherkin/intent", props: { title: "Plans for visitors", status: "draft" }, edges: [{ type: "gherkin/has", to: "O-0001" }, { type: "gherkin/has", to: "K-0001" }, { type: "gherkin/has", to: "Q-0001" }] },
          { id: "O-0001", type: "gherkin/outcome", props: { text: "A visitor picks a plan in one minute" }, edges: [] },
          { id: "K-0001", type: "gherkin/constraint", props: { text: "Prices never hide fees" }, edges: [] },
          { id: "Q-0001", type: "gherkin/question", props: { text: "Is there a yearly plan?" }, edges: [] },
        ])
        const e = (ref: string) => PluginHost.use((h) => h.entities.get(ref))
        return [yield* e("gherkin/intent:I-0001"), yield* e("gherkin/outcome:O-0001"), yield* e("gherkin/constraint:K-0001"), yield* e("gherkin/question:Q-0001")]
      }),
    )
    expect(got.map((x) => x.label.text)).toEqual(["Plans for visitors", "A visitor picks a plan in one minute", "Prices never hide fees", "Is there a yearly plan?"])
    expect(got.every((x) => /^[0-9a-f]{12}$/.test(x.version))).toBe(true)
  })
})
```

Check first that `GraphStore` has `commit` with this shape: `grep -n "readonly commit" packages/graph/src/store.ts`. If the name differs, use the store's write method (the one `host.call` uses after its checks) and change the `put` helper to match.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/plugin-gherkin && mise x -- bun test test/intents.test.ts`
Expected: FAIL with `no plugin serves gherkin/intent` (or an unknown-type finding).

- [ ] **Step 3: Implement**

Append to `packages/plugin-gherkin/src/model.ts`:
```ts
export const INTENT = "gherkin/intent"
export const OUTCOME = "gherkin/outcome"
export const CONSTRAINT = "gherkin/constraint"
export const QUESTION = "gherkin/question"
/** intent → outcome, constraint or question: the statement is this intent's (exactly one). */
export const HAS = "gherkin/has"
/** intent → persona: the users this intent is for. */
export const FOR = "gherkin/for"
/** journey → outcome: the journey delivers the outcome. */
export const SERVES = "gherkin/serves"
/** constraint → journey or scenario: the rule applies there. */
export const BOUNDS = "gherkin/bounds"
export const STATEMENT_TYPES: ReadonlyArray<string> = [OUTCOME, CONSTRAINT, QUESTION]

/** What one product (or one area of it) is for. The problem is context, not traced; its statements are. */
export const IntentProps = Schema.Struct({
  title: Schema.NonEmptyString,
  problem: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["draft", "accepted"]),
})
/** An outcome or a constraint: one sentence. */
export const StatementProps = Schema.Struct({ text: Schema.NonEmptyString })
/** A question is open until it has an answer. */
export const QuestionProps = Schema.Struct({ text: Schema.NonEmptyString, answer: Schema.optionalKey(Schema.NonEmptyString) })

export const isStatement = (n: Node): boolean => STATEMENT_TYPES.includes(n.type)
export const intents = (snap: Snapshot.Snapshot) => Snapshot.byType(snap, INTENT)
export const statementsOf = (snap: Snapshot.Snapshot, intent: string): ReadonlyArray<Node> =>
  Snapshot.out(snap, intent, HAS).flatMap((e) => { const n = snap.nodes.get(e.to); return n === undefined ? [] : [n] })
export const intentOf = (snap: Snapshot.Snapshot, statement: string): string | undefined => Snapshot.inbound(snap, statement, HAS)[0]?.from
export const servedBy = (snap: Snapshot.Snapshot, outcome: string): ReadonlyArray<string> => Snapshot.inbound(snap, outcome, SERVES).map((e) => e.from).sort()
```

In `packages/plugin-gherkin/src/index.ts`:
- import `CONSTRAINT, INTENT, IntentProps, OUTCOME, QUESTION, QuestionProps, StatementProps` from `./model`;
- extend `PROPS`: `[INTENT]: IntentProps, [OUTCOME]: StatementProps, [CONSTRAINT]: StatementProps, [QUESTION]: QuestionProps`;
- extend `EDGES`:
```ts
  // An intent's statements: each statement is exactly one intent's (the statement-owner lint).
  has: { from: "intent", to: ["outcome", "constraint", "question"] },
  // The users an intent is for.
  for: { from: "intent", to: "persona" },
  // A journey delivers an outcome (many to many).
  serves: { from: "journey", to: "outcome" },
  // A constraint applies to a journey or a scenario.
  bounds: { from: "constraint", to: ["journey", "scenario"] },
```
- `graph.nodes`: add `intent: IntentProps, outcome: StatementProps, constraint: StatementProps, question: QuestionProps`;
- `entities` (in `definePlugin`):
```ts
    intent: { doc: "What one product (or one area of it) is for: a title, the problem, its outcomes, constraints and questions.", data: IntentProps, tone: "accent", glyph: "◈", ops: ["label"] },
    outcome: { doc: "One result an intent wants for its users; journeys serve it.", data: StatementProps, tone: "ok", glyph: "▸", ops: ["label"] },
    constraint: { doc: "One rule that must hold where it bounds.", data: StatementProps, tone: "attention", glyph: "▪", ops: ["label"] },
    question: { doc: "One thing an intent has not decided yet; open until answered.", data: QuestionProps, tone: "dim", glyph: "?", ops: ["label"] },
```
- the `entities` handler object in `make`:
```ts
      intent: { get: nodes, label: (e: E) => String(e.data.props.title ?? e.id) },
      outcome: { get: nodes, label: (e: E) => String(e.data.props.text ?? e.id) },
      constraint: { get: nodes, label: (e: E) => String(e.data.props.text ?? e.id) },
      question: { get: nodes, label: (e: E) => String(e.data.props.text ?? e.id) },
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/plugin-gherkin && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS (all gherkin tests).

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/plugin-gherkin && git commit -m "feat(gherkin): intent, outcome, constraint and question nodes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Tools for intents and statements; link, unlink and remove know the new edges

**Files:**
- Create: `packages/plugin-gherkin/src/intent-tools.ts`
- Modify: `packages/plugin-gherkin/src/tools.ts` (`EdgeName`, `link`, `unlink`, `remove`, `tools`)
- Test: `packages/plugin-gherkin/test/intents.test.ts`

**Interfaces:**
- Consumes: the model helpers from Task 2.
- Produces these tools (names as `gherkin/<name>`):
  - `add-intent {title, problem?, status?}` → `created I-0001`;
  - `edit-intent {id, title?, problem?, status?}`;
  - `add-outcome {intent, text}` → `created O-0001 in I-0001`;
  - `add-constraint {intent, text}` → `K-`;
  - `ask-question {intent, text}` → `Q-`;
  - `edit-outcome`, `edit-constraint` and `edit-question`, each `{id, text}`;
  - `answer-question {id, answer, as?: "outcome" | "constraint"}`;
  - `link` and `unlink` with `edge: "serves" | "bounds" | "for"`:
    - serves: `{journey: JourneyRef, outcome: string}`;
    - bounds: `{constraint: string, journey?: JourneyRef, scenario?: string}`;
    - for: `{intent: string, persona: PersonaRef}`;
  - `scenario` stays required for the scenario edges, so link and unlink calls already stored keep working.

- [ ] **Step 1: Write the failing tests** (append to `intents.test.ts`)

```ts
describe("intent tools", () => {
  const visitor = call("add-persona", { name: "Visitor", kind: "human", text: "Someone choosing a plan on the website." })
  test("add an intent and its statements; each statement is in its intent; a question is answered into an outcome", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* visitor
        const m = (r: { message: string }) => r.message
        const out = [
          m(yield* call("add-intent", { title: "Plans for visitors", problem: "Visitors leave the pricing page." })),
          m(yield* call("add-outcome", { intent: "I-0001", text: "A visitor picks a plan in one minute" })),
          m(yield* call("add-constraint", { intent: "I-0001", text: "Prices never hide fees" })),
          m(yield* call("ask-question", { intent: "I-0001", text: "Is there a yearly plan?" })),
          m(yield* call("answer-question", { id: "Q-0001", answer: "Yearly plans cost ten months", as: "outcome" })),
          m(yield* call("link", { intent: "I-0001", edge: "for", persona: { name: "Visitor" } })),
        ]
        const snap = yield* GraphStore.use((g) => g.snapshot)
        return { out, intent: snap.nodes.get("I-0001"), q: snap.nodes.get("Q-0001")?.props }
      }),
    )
    expect(got.out).toEqual(["created I-0001", "created O-0001 in I-0001", "created K-0001 in I-0001", "created Q-0001 in I-0001", "answered Q-0001; created O-0002 in I-0001", "linked I-0001 for P-0001"])
    expect(got.intent?.props).toEqual({ title: "Plans for visitors", problem: "Visitors leave the pricing page.", status: "draft" })
    expect(got.intent?.edges).toEqual([
      { type: "gherkin/has", to: "O-0001" }, { type: "gherkin/has", to: "K-0001" }, { type: "gherkin/has", to: "Q-0001" }, { type: "gherkin/has", to: "O-0002" }, { type: "gherkin/for", to: "P-0001" },
    ])
    expect(got.q).toEqual({ text: "Is there a yearly plan?", answer: "Yearly plans cost ten months" })
  })

  test("serves and bounds: a journey serves an outcome, a constraint bounds a journey and a scenario; unlink takes them back", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* visitor
        yield* call("add-state", { text: "the visitor is on the home page", entry: true })
        yield* call("add-scenario", { title: "Visitor opens pricing", when: "the visitor opens pricing", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the plan picker is shown" }] })
        yield* call("add-journey", { name: "Checkout" })
        yield* call("add-intent", { title: "Plans for visitors" })
        yield* call("add-outcome", { intent: "I-0001", text: "A visitor picks a plan in one minute" })
        yield* call("add-constraint", { intent: "I-0001", text: "Prices never hide fees" })
        const linked = [
          (yield* call("link", { edge: "serves", journey: { name: "Checkout" }, outcome: "O-0001" })).message,
          (yield* call("link", { edge: "bounds", constraint: "K-0001", journey: { id: "J-0001" } })).message,
          (yield* call("link", { edge: "bounds", constraint: "K-0001", scenario: "S-0001" })).message,
        ]
        const wrong = said(yield* Effect.flip(call("link", { edge: "serves", journey: { id: "J-0001" }, outcome: "K-0001" })))
        yield* call("unlink", { edge: "serves", journey: "J-0001", outcome: "O-0001" })
        const snap = yield* GraphStore.use((g) => g.snapshot)
        return { linked, wrong, journey: snap.nodes.get("J-0001")?.edges, k: snap.nodes.get("K-0001")?.edges }
      }),
    )
    expect(got.linked).toEqual(["linked J-0001 serves O-0001", "linked K-0001 bounds J-0001", "linked K-0001 bounds S-0001"])
    expect(got.wrong).toContain("K-0001 is not a gherkin/outcome")
    expect(got.journey).toEqual([])
    expect(got.k).toEqual([{ type: "gherkin/bounds", to: "J-0001" }, { type: "gherkin/bounds", to: "S-0001" }])
  })

  test("removing a served outcome drops its has and serves edges; an intent with statements is not removed", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* call("add-journey", { name: "Checkout" })
        yield* call("add-intent", { title: "Plans for visitors" })
        yield* call("add-outcome", { intent: "I-0001", text: "A visitor picks a plan in one minute" })
        yield* call("link", { edge: "serves", journey: { id: "J-0001" }, outcome: "O-0001" })
        const refused = said(yield* Effect.flip(call("remove", { id: "I-0001" })))
        const removed = (yield* call("remove", { id: "O-0001" })).message
        const snap = yield* GraphStore.use((g) => g.snapshot)
        return { refused, removed, gone: !snap.nodes.has("O-0001"), intent: snap.nodes.get("I-0001")?.edges, journey: snap.nodes.get("J-0001")?.edges, last: (yield* call("remove", { id: "I-0001" })).message }
      }),
    )
    expect(got).toEqual({ refused: "I-0001 has statements O-0001; remove them first", removed: "removed O-0001", gone: true, intent: [], journey: [], last: "removed I-0001" })
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd packages/plugin-gherkin && mise x -- bun test test/intents.test.ts`
Expected: FAIL with `no tool gherkin/add-intent` (or the host's equivalent unknown-tool error).

- [ ] **Step 3: Implement `intent-tools.ts`**

```ts
import { Effect, Schema } from "effect"
import { type Node, Put, Snapshot } from "@zarg/graph/pure"
import { tool, ToolError } from "./kit"
import { CONSTRAINT, HAS, INTENT, OUTCOME, QUESTION } from "./model"

const Title = Schema.NonEmptyString.annotate({ description: "What it is for, at most 10 words." })
const Text = Schema.NonEmptyString.annotate({ description: 'One sentence, at most 20 words, no "if", one idea.' })
const Status = Schema.Literals(["draft", "accepted"])

const nodeOf = (snap: Snapshot.Snapshot, id: string, type: string) => {
  const n = snap.nodes.get(id)
  return n?.type === type ? Effect.succeed(n) : Effect.fail(new ToolError({ message: `${id} is not a ${type}` }))
}

export const addIntent = tool({
  name: "add-intent",
  description: "Add an intent: what one product (or one area of it) is for. Its outcomes, constraints and questions come after.",
  params: Schema.Struct({ title: Title, problem: Schema.optionalKey(Schema.String), status: Schema.optionalKey(Status) }),
  run: (p, snap) =>
    Effect.sync(() => {
      const id = Snapshot.nextId(snap, "I")
      return { changes: [Put({ id, type: INTENT, props: { title: p.title, ...(p.problem !== undefined ? { problem: p.problem } : {}), status: p.status ?? "draft" }, edges: [] })], message: `created ${id}` }
    }),
})

export const editIntent = tool({
  name: "edit-intent",
  description: "Change an intent's title, problem or status (draft, accepted).",
  params: Schema.Struct({ id: Schema.String, title: Schema.optionalKey(Title), problem: Schema.optionalKey(Schema.String), status: Schema.optionalKey(Status) }),
  run: ({ id, ...patch }, snap) => Effect.map(nodeOf(snap, id, INTENT), (n) => ({ changes: [Put({ ...n, props: { ...n.props, ...patch } })], message: `updated ${id}` })),
})

/** A new statement in an intent: the node, and the intent with its has edge. */
const addTo = (snap: Snapshot.Snapshot, intent: string, type: string, prefix: string, props: Readonly<Record<string, unknown>>) =>
  Effect.map(nodeOf(snap, intent, INTENT), (i) => {
    const id = Snapshot.nextId(snap, prefix)
    const node: Node = { id, type, props, edges: [] }
    return { id, changes: [Put(node), Put({ ...i, edges: [...i.edges, { type: HAS, to: id }] })] }
  })

const statement = (name: string, type: string, prefix: string, what: string) => ({
  add: tool({
    name: name === "question" ? "ask-question" : `add-${name}`,
    description: `Add ${what} to an intent.`,
    params: Schema.Struct({ intent: Schema.String, text: Text }),
    run: (p, snap) => Effect.map(addTo(snap, p.intent, type, prefix, { text: p.text }), (r) => ({ changes: r.changes, message: `created ${r.id} in ${p.intent}` })),
  }),
  edit: tool({
    name: `edit-${name}`,
    description: `Reword ${what}.`,
    params: Schema.Struct({ id: Schema.String, text: Text }),
    run: ({ id, text }, snap) => Effect.map(nodeOf(snap, id, type), (n) => ({ changes: [Put({ ...n, props: { ...n.props, text } })], message: `updated ${id}` })),
  }),
})

const outcome = statement("outcome", OUTCOME, "O", "an outcome (one result the intent wants for its users)")
const constraint = statement("constraint", CONSTRAINT, "K", "a constraint (one rule that must hold where it bounds)")
const question = statement("question", QUESTION, "Q", "an open question (one thing not decided yet)")

export const answerQuestion = tool({
  name: "answer-question",
  description: "Answer an open question; with as, the answer also becomes an outcome or a constraint of the same intent.",
  params: Schema.Struct({ id: Schema.String, answer: Text, as: Schema.optionalKey(Schema.Literals(["outcome", "constraint"])) }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const q = yield* nodeOf(snap, p.id, QUESTION)
      const answered = Put({ ...q, props: { ...q.props, answer: p.answer } })
      if (p.as === undefined) return { changes: [answered], message: `answered ${p.id}` }
      const intent = Snapshot.inbound(snap, p.id, HAS)[0]?.from
      if (intent === undefined) return yield* new ToolError({ message: `${p.id} is in no intent` })
      const r = yield* addTo(snap, intent, p.as === "outcome" ? OUTCOME : CONSTRAINT, p.as === "outcome" ? "O" : "K", { text: p.answer })
      return { changes: [answered, ...r.changes], message: `answered ${p.id}; created ${r.id} in ${intent}` }
    }),
})

export const intentTools = [addIntent, editIntent, outcome.add, outcome.edit, constraint.add, constraint.edit, question.add, question.edit, answerQuestion]
```

- [ ] **Step 4: Extend `tools.ts`**

Imports: add `BOUNDS, CONSTRAINT, FOR, HAS, INTENT, isStatement, OUTCOME, SERVES` from `./model`, and `intentTools` from `./intent-tools`.

Replace `EdgeName` and `edgeType`:
```ts
const EdgeName = Schema.Literals(["arrives", "given", "then", "by", "in", "serves", "bounds", "for"])
const edgeType = { arrives: ARRIVES, given: GIVEN, then: THEN, by: BY, in: IN, serves: SERVES, bounds: BOUNDS, for: FOR } as const
```

Replace `link` with a version that picks the source node by edge:
```ts
export const link = tool({
  name: "link",
  description:
    "Connect a scenario to a state as arrives (replaces the current one), given or then; to a persona as by; or to a journey as in. Also: a journey serves an outcome {edge: \"serves\", journey, outcome}; a constraint bounds a journey or a scenario {edge: \"bounds\", constraint, journey or scenario}; an intent is for a persona {edge: \"for\", intent, persona}.",
  params: Schema.Struct({
    scenario: Schema.optionalKey(Schema.String),
    edge: EdgeName,
    state: Schema.optionalKey(StateRef),
    persona: Schema.optionalKey(PersonaRef),
    journey: Schema.optionalKey(JourneyRef),
    outcome: Schema.optionalKey(Schema.String),
    constraint: Schema.optionalKey(Schema.String),
    intent: Schema.optionalKey(Schema.String),
  }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const type = edgeType[p.edge]
      // The source owns the edge: the journey (serves), the constraint (bounds), the intent (for), else the scenario.
      const linkFrom = (source: Node, to: string, created: ReadonlyArray<Node> = []) =>
        source.edges.some((e) => e.type === type && e.to === to)
          ? Effect.fail(new ToolError({ message: `${source.id} already has ${p.edge} ${to}` }))
          : Effect.succeed({ changes: [...created.map(Put), Put({ ...source, edges: [...(p.edge === "arrives" ? source.edges.filter((e) => e.type !== ARRIVES) : source.edges), { type, to }] })] as Array<Change>, message: `linked ${source.id} ${p.edge} ${to}${createdNote(created)}` })
      if (p.edge === "serves") {
        if (p.journey === undefined || p.outcome === undefined) return yield* new ToolError({ message: "serves takes {journey: {id} or {name}, outcome: id}" })
        const journey = yield* getNode(snap, yield* journeyOf(snap, p.journey), JOURNEY)
        yield* getNode(snap, p.outcome, OUTCOME)
        return yield* linkFrom(journey, p.outcome)
      }
      if (p.edge === "bounds") {
        if (p.constraint === undefined || (p.journey === undefined) === (p.scenario === undefined)) return yield* new ToolError({ message: "bounds takes {constraint: id} and one of {journey: {id} or {name}} or {scenario: id}" })
        const constraint = yield* getNode(snap, p.constraint, CONSTRAINT)
        const to = p.journey !== undefined ? yield* journeyOf(snap, p.journey) : (yield* getNode(snap, p.scenario!, SCENARIO)).id
        return yield* linkFrom(constraint, to)
      }
      if (p.edge === "for") {
        if (p.intent === undefined || p.persona === undefined) return yield* new ToolError({ message: "for takes {intent: id, persona: {id} or {name}}" })
        return yield* linkFrom(yield* getNode(snap, p.intent, INTENT), yield* personaOf(snap, p.persona))
      }
      if (p.scenario === undefined) return yield* new ToolError({ message: `${p.edge} takes {scenario: id}` })
      const scenario = yield* getNode(snap, p.scenario, SCENARIO)
      if (p.edge === "by" && p.persona === undefined) return yield* new ToolError({ message: "by takes a persona: {persona: {id} or {name}}" })
      if (p.edge === "in" && p.journey === undefined) return yield* new ToolError({ message: "in takes a journey: {journey: {id} or {name}}" })
      if (p.edge !== "by" && p.edge !== "in" && p.state === undefined) return yield* new ToolError({ message: `${p.edge} takes a state: {state: {id} or {text}}` })
      const r = resolver(snap)
      const to = p.edge === "by" ? yield* personaOf(snap, p.persona!) : p.edge === "in" ? yield* journeyOf(snap, p.journey!) : yield* r.resolve(p.state!)
      return yield* linkFrom(scenario, to, r.created)
    }),
})
```
The message for an existing scenario edge keeps its old form: `${p.scenario} already has ${p.edge} ${to}` reads the same, since `source.id === p.scenario`.

Replace `unlink`:
```ts
export const unlink = tool({
  name: "unlink",
  description:
    "Remove a given or then edge (state id), a by edge (persona id) or an in edge (journey id) from a scenario; or serves {journey: id, outcome}, bounds {constraint, journey or scenario: id}, for {intent, persona: id}.",
  params: Schema.Struct({
    scenario: Schema.optionalKey(Schema.String),
    edge: EdgeName,
    state: Schema.optionalKey(Schema.String),
    persona: Schema.optionalKey(Schema.String),
    journey: Schema.optionalKey(Schema.String),
    outcome: Schema.optionalKey(Schema.String),
    constraint: Schema.optionalKey(Schema.String),
    intent: Schema.optionalKey(Schema.String),
  }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const type = edgeType[p.edge]
      const [sourceId, target, sourceType] =
        p.edge === "serves" ? [p.journey, p.outcome, JOURNEY]
        : p.edge === "bounds" ? [p.constraint, p.journey ?? p.scenario, CONSTRAINT]
        : p.edge === "for" ? [p.intent, p.persona, INTENT]
        : [p.scenario, p.edge === "by" ? p.persona : p.edge === "in" ? p.journey : p.state, SCENARIO]
      if (sourceId === undefined || target === undefined) return yield* new ToolError({ message: p.edge === "by" ? "by takes a persona id" : p.edge === "in" ? "in takes a journey id" : `${p.edge} takes its source and target ids` })
      const source = yield* getNode(snap, sourceId, sourceType)
      const edges = source.edges.filter((e) => !(e.type === type && e.to === target))
      if (edges.length === source.edges.length) return yield* new ToolError({ message: `${sourceId} has no ${p.edge} ${target}` })
      if (type === BY && !edges.some((e) => e.type === BY)) return yield* new ToolError({ message: `${target} is its last persona on ${sourceId}; link another first` })
      return { changes: [Put({ ...source, edges })], message: `unlinked ${sourceId} ${p.edge} ${target}` }
    }),
})
```

Replace `remove`'s `run`:
```ts
  run: ({ id }, snap) =>
    Effect.gen(function* () {
      const n = snap.nodes.get(id)
      if (n === undefined) return yield* new ToolError({ message: `no node ${id}` })
      // A statement goes with the edges that point at it (its intent's has, the journeys' serves).
      if (isStatement(n)) {
        const sources = [...new Set(Snapshot.inbound(snap, id).map((e) => e.from))].flatMap((s) => { const src = snap.nodes.get(s); return src === undefined ? [] : [src] })
        return { changes: [...sources.map((s) => Put({ ...s, edges: s.edges.filter((e) => e.to !== id) })), Remove(id)], message: `removed ${id}` }
      }
      if (n.type === INTENT) {
        const own = n.edges.filter((e) => e.type === HAS).map((e) => e.to)
        if (own.length > 0) return yield* new ToolError({ message: `${id} has statements ${own.join(", ")}; remove them first` })
      }
      const users = Snapshot.inbound(snap, id).map((e) => e.from)
      if (users.length > 0) {
        return yield* new ToolError({ message: `${id} is used by ${[...new Set(users)].join(", ")}; relink or remove them first` })
      }
      return { changes: [Remove(id)], message: `removed ${id}` }
    }),
```
Update `remove`'s description: `"Remove a scenario; a state, persona or journey that nothing uses; an outcome, constraint or question (with the edges to it); or an intent without statements."`.

Finally: `export const tools = [addState, editState, addPersona, editPersona, addJourney, editJourney, addScenario, editScenario, link, unlink, remove, ...intentTools]`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd packages/plugin-gherkin && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS. The existing journeys tests, including `link`/`unlink` with `scenario`, still pass.

- [ ] **Step 6: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/plugin-gherkin && git commit -m "feat(gherkin): tools for intents and statements; serves, bounds and for

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Lints — statement shape, intent title, one intent per statement

**Files:**
- Modify: `packages/plugin-gherkin/src/lints.ts`
- Modify: `packages/plugin-gherkin/src/index.ts` (one `LINTS` list, used by `lint`, `dryRun` and `compare`)
- Test: `packages/plugin-gherkin/test/intents.test.ts`

**Interfaces:**
- Produces `LINTS: ReadonlyArray<Lint>` from `lints.ts`: `clauseShape`, `stateText`, `personaShape`, `journeyShape`, `intentShape` and `statementOwner`.
  - `clauseShape` covers statements, with a 20-word limit.
  - `intentShape`: error `intent-title-long` (more than 10 words).
  - `statementOwner`: error `statement-owner`, with the message `<id> belongs to no intent` or `<id> belongs to I-a, I-b; a statement belongs to exactly one intent`.

- [ ] **Step 1: Write the failing tests** (append to `intents.test.ts`)

```ts
describe("intent lints", () => {
  test("a statement of 21 words, or with if, is refused; 20 words pass; a long intent title is refused", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* call("add-intent", { title: "Plans for visitors" })
        const twenty = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ")
        const ok = (yield* call("add-outcome", { intent: "I-0001", text: twenty })).message
        const long = said(yield* Effect.flip(call("add-outcome", { intent: "I-0001", text: `${twenty} more` })))
        const cond = said(yield* Effect.flip(call("add-constraint", { intent: "I-0001", text: "fees show if the visitor asks" })))
        const title = said(yield* Effect.flip(call("add-intent", { title: "one two three four five six seven eight nine ten eleven" })))
        return { ok, long, cond, title }
      }),
    )
    expect(got.ok).toBe("created O-0001 in I-0001")
    expect(got.long).toContain("has 21 words; keep it to 20 or fewer")
    expect(got.cond).toContain('contains "if"')
    expect(got.title).toContain("I-0002: its title has 11 words; keep it to 10 or fewer")
  })
})
```

Tools can't produce a statement with two intents, so test `statementOwner` directly on snapshots (append):
```ts
import { diff, Snapshot } from "@zarg/graph/pure"
import { statementOwner } from "../src/lints"

test("statementOwner: a statement two intents claim, or none, is an error", () => {
  const intent = (id: string, has: ReadonlyArray<string>) => ({ id, type: "gherkin/intent", props: { title: id, status: "draft" }, edges: has.map((to) => ({ type: "gherkin/has", to })) })
  const outcome = (id: string) => ({ id, type: "gherkin/outcome", props: { text: id }, edges: [] })
  const before = Snapshot.make([intent("I-1", ["O-1"]), intent("I-2", []), outcome("O-1")] as never)
  const lint = (after: Snapshot.Snapshot) => statementOwner({ before, after, diff: diff(before, after) }).map((f) => f.message)
  expect(lint(Snapshot.make([intent("I-1", ["O-1"]), intent("I-2", ["O-1"]), outcome("O-1")] as never))).toEqual(["O-1 belongs to I-1, I-2; a statement belongs to exactly one intent"])
  expect(lint(Snapshot.make([intent("I-1", []), intent("I-2", []), outcome("O-1")] as never))).toEqual(["O-1 belongs to no intent"])
  expect(lint(before)).toEqual([])
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd packages/plugin-gherkin && mise x -- bun test test/intents.test.ts`
Expected: FAIL. The 21-word outcome is created, and `statementOwner` is not exported.

- [ ] **Step 3: Implement** (in `lints.ts`)

Imports: add `HAS, INTENT, isStatement` from `./model`.

Replace `MAX_WORDS` and `clauses`, and make the limit per node:
```ts
const MAX_WORDS = 15
/** A statement (outcome, constraint, question) is one sentence of at most 20 words. */
const MAX_STATEMENT_WORDS = 20

const clauses = (n: Node): ReadonlyArray<string> =>
  n.type === STATE || isStatement(n) ? [text(n)] : n.type === SCENARIO ? [String(n.props.when ?? "")] : []
```
In `clauseShape`, use `const max = isStatement(n) ? MAX_STATEMENT_WORDS : MAX_WORDS`, and word the message by kind:
```ts
      if (count > max) {
        out.push({ severity: "error", code: "clause-too-long", message: isStatement(n) ? `${n.id}: "${c}" has ${count} words; keep it to ${max} or fewer` : `${n.id}: "${c}" has ${count} words; keep clauses to ${max} or fewer`, about: [n.id] })
      }
```
Append:
```ts
/** An intent's title: at most 10 words. */
export const intentShape: Lint = (ctx) =>
  touched(ctx)
    .filter((n) => n.type === INTENT)
    .flatMap((n): ReadonlyArray<Finding> => {
      const count = words(String(n.props.title ?? ""))
      return count > 10 ? [{ severity: "error", code: "intent-title-long", message: `${n.id}: its title has ${count} words; keep it to 10 or fewer`, about: [n.id] }] : []
    })

/** Every statement belongs to exactly one intent: the touched statements, and those a touched intent claims or let go. */
export const statementOwner: Lint = (ctx) => {
  const t = touched(ctx)
  const hasTargets = (s: typeof ctx.after, id: string) => (s.nodes.get(id)?.edges ?? []).filter((e) => e.type === HAS).map((e) => e.to)
  const ids = new Set([
    ...t.filter(isStatement).map((n) => n.id),
    ...t.filter((n) => n.type === INTENT).flatMap((n) => [...hasTargets(ctx.before, n.id), ...hasTargets(ctx.after, n.id)]),
  ])
  return [...ids].flatMap((id): ReadonlyArray<Finding> => {
    const n = ctx.after.nodes.get(id)
    if (n === undefined || !isStatement(n)) return []
    const owners = Snapshot.inbound(ctx.after, id, HAS).map((e) => e.from).sort()
    if (owners.length === 1) return []
    return [{ severity: "error", code: "statement-owner", message: owners.length === 0 ? `${id} belongs to no intent` : `${id} belongs to ${owners.join(", ")}; a statement belongs to exactly one intent`, about: [id, ...owners] }]
  })
}

export const LINTS: ReadonlyArray<Lint> = [clauseShape, stateText, personaShape, journeyShape, intentShape, statementOwner]
```
Add `import { Snapshot } from "@zarg/graph/pure"` and keep `type Node`. `words` is already defined in `lints.ts`; move it above `intentShape` if needed.

In `index.ts`, import `LINTS` and replace the three literal arrays `[clauseShape, stateText, personaShape, journeyShape]` (in `lint`, `dryRun` and `compare`) with `LINTS`. Drop the now-unused imports.

Removing a statement (Task 3) drops `has` from the intent: the intent is touched, the statement is gone, and `n === undefined` returns no finding. That is correct.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/plugin-gherkin && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/plugin-gherkin && git commit -m "feat(gherkin): statements are atomic and belong to one intent

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Agenda items and render for intents

**Files:**
- Modify: `packages/plugin-gherkin/src/agenda.ts`
- Modify: `packages/plugin-gherkin/src/render.ts`
- Test: `packages/plugin-gherkin/test/intents.test.ts`

**Interfaces:**
- Produces these agenda items:
  - `gherkin:uncovered`: one item listing every outcome no journey serves (priority 2);
  - `gherkin:unserving`: one item listing every journey that serves no outcome (priority 3), raised only while some outcome exists;
  - `gherkin:question:<Q>`: one per open question (priority 2);
  - `gherkin:no-outcome:<I>`: one per intent without outcomes (priority 2).
- Produces `renderIntent(snap, intent: Node): string`. `render(snap, focus)` includes the intents that are in the focus set or own a statement in it, before the scenarios.

- [ ] **Step 1: Write the failing tests** (append to `intents.test.ts`)

```ts
import { agenda } from "../src/agenda"
import { render } from "../src/render"

const graph = (...nodes: ReadonlyArray<unknown>) => Snapshot.make(nodes as never)
const n = (id: string, type: string, props: Record<string, unknown>, edges: ReadonlyArray<[string, string]> = []) => ({ id, type: `gherkin/${type}`, props, edges: edges.map(([t, to]) => ({ type: `gherkin/${t}`, to })) })

describe("intent agenda", () => {
  const base = [
    n("I-0001", "intent", { title: "Plans", status: "draft" }, [["has", "O-0001"], ["has", "O-0002"], ["has", "Q-0001"]]),
    n("O-0001", "outcome", { text: "A visitor picks a plan" }),
    n("O-0002", "outcome", { text: "A receipt arrives" }),
    n("Q-0001", "question", { text: "Is there a yearly plan?" }),
    n("I-0002", "intent", { title: "Empty", status: "draft" }),
    n("J-0001", "journey", { name: "Checkout" }, [["serves", "O-0001"]]),
    n("J-0002", "journey", { name: "Browse" }),
    n("J-0003", "journey", { name: "Help" }),
  ]
  const ids = (s: Snapshot.Snapshot) => agenda(s).filter((i) => /uncovered|unserving|question|no-outcome/.test(i.id))
  test("uncovered outcomes and unserving journeys are one item each; each open question and each intent without outcomes has its own", () => {
    const items = ids(graph(...base))
    expect(items.map((i) => [i.id, i.about])).toEqual([
      ["gherkin:uncovered", ["O-0002"]],
      ["gherkin:unserving", ["J-0002", "J-0003"]],
      ["gherkin:question:Q-0001", ["Q-0001"]],
      ["gherkin:no-outcome:I-0002", ["I-0002"]],
    ])
    expect(items[0]!.title).toBe("Which journey delivers 1 outcome?")
  })
  test("an answered question is no item; without any outcome no journey is unserving", () => {
    const answered = base.map((x) => (x.id === "Q-0001" ? { ...x, props: { ...x.props, answer: "No" } } : x))
    expect(ids(graph(...answered)).map((i) => i.id)).not.toContain("gherkin:question:Q-0001")
    expect(ids(graph(n("J-0001", "journey", { name: "Checkout" }))).map((i) => i.id)).toEqual([])
  })
})

describe("render with intents", () => {
  test("an intent in focus renders its status, personas and statements with what serves or bounds them", () => {
    const s = graph(
      n("I-0001", "intent", { title: "Plans", status: "accepted", problem: "Visitors leave." }, [["has", "O-0001"], ["has", "K-0001"], ["has", "Q-0001"], ["for", "P-0001"]]),
      n("O-0001", "outcome", { text: "A visitor picks a plan" }),
      n("K-0001", "constraint", { text: "Prices never hide fees" }, [["bounds", "J-0001"]]),
      n("Q-0001", "question", { text: "Is there a yearly plan?" }),
      n("P-0001", "persona", { name: "Visitor", kind: "human", text: "x" }),
      n("J-0001", "journey", { name: "Checkout" }, [["serves", "O-0001"]]),
    )
    expect(render(s, new Set(["O-0001"]))).toBe(
      [
        "I-0001 Plans",
        "  Status     accepted",
        "  For        Visitor  # P-0001",
        "  Outcome    A visitor picks a plan  # O-0001 ← J-0001",
        "  Constraint Prices never hide fees  # K-0001 → J-0001",
        "  Question   Is there a yearly plan?  # Q-0001 (open)",
      ].join("\n"),
    )
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd packages/plugin-gherkin && mise x -- bun test test/intents.test.ts`
Expected: FAIL. No intent items, and render returns `""` for the focus.

- [ ] **Step 3: Implement**

`agenda.ts`: import `intents, JOURNEY, journeyName, OUTCOME, QUESTION, SERVES, statementsOf` from `./model`. At the end of `agenda`, before `return items`, add `items.push(...intentItems(snap))`. The early return for an empty graph stays as it is.
```ts
/** Outcomes no journey serves and journeys serving none (one item each, never one per node), open questions, intents without outcomes. */
const intentItems = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> => {
  const items: Array<AgendaItem> = []
  const outcomes = Snapshot.byType(snap, OUTCOME)
  const uncovered = outcomes.filter((o) => Snapshot.inbound(snap, o.id, SERVES).length === 0)
  if (uncovered.length > 0)
    items.push({
      id: "gherkin:uncovered",
      title: `Which journey delivers ${uncovered.length} outcome${uncovered.length === 1 ? "" : "s"}?`,
      detail: `${uncovered.slice(0, 20).map((o) => `${o.id} "${text(o)}"`).join(", ")}${uncovered.length > 20 ? ` and ${uncovered.length - 20} more` : ""}: no journey serves them. Link a journey with link {edge: "serves", journey, outcome}, or shape a new journey for it.`,
      about: uncovered.map((o) => o.id),
      priority: 2,
    })
  // A journey serves nothing only once there are outcomes to serve.
  const unserving = outcomes.length === 0 ? [] : Snapshot.byType(snap, JOURNEY).filter((j) => !j.edges.some((e) => e.type === SERVES))
  if (unserving.length > 0)
    items.push({
      id: "gherkin:unserving",
      title: `What do ${unserving.length} journey${unserving.length === 1 ? "" : "s"} serve?`,
      detail: `${unserving.map((j) => `${j.id} ${journeyName(j)}`).join(", ")} serve no outcome. Link each with link {edge: "serves", journey, outcome}, or ask whether it still belongs.`,
      about: unserving.map((j) => j.id),
      priority: 3,
    })
  for (const q of Snapshot.byType(snap, QUESTION))
    if (q.props.answer === undefined) items.push({ id: `gherkin:question:${q.id}`, title: text(q), detail: `${q.id} is open. Answer it with answer-question (as an outcome or a constraint when it decides one).`, about: [q.id], priority: 2 })
  for (const i of intents(snap))
    if (!statementsOf(snap, i.id).some((s) => s.type === OUTCOME)) items.push({ id: `gherkin:no-outcome:${i.id}`, title: `What should "${String(i.props.title)}" achieve?`, detail: `${i.id} has no outcome yet. Add one with add-outcome.`, about: [i.id], priority: 2 })
  return items
}
```
Also change `no-personas` detail's first sentence to: `"No personas yet. Draft them from the intents (who each is for) and the conversation (…"`, keeping the rest of the sentence. Find it with `grep -n "frontmatter personas" src/agenda.ts`.

`render.ts`: import `BOUNDS, CONSTRAINT, FOR, INTENT, intentOf, intents, OUTCOME, QUESTION, SERVES, statementsOf` from `./model`.
```ts
const KEYWORD: Readonly<Record<string, string>> = { [OUTCOME]: "Outcome", [CONSTRAINT]: "Constraint", [QUESTION]: "Question" }

/** One intent: status, who it is for, then each statement with what serves it (←), what it bounds (→) or whether it is open. */
export const renderIntent = (snap: Snapshot.Snapshot, intent: Node): string => {
  const pad = (k: string) => k.padEnd(10)
  const name = (id: string) => { const n = snap.nodes.get(id); return n === undefined ? `<missing ${id}>` : String(n.props.name ?? n.props.title ?? n.props.text ?? id) }
  const fors = Snapshot.out(snap, intent.id, FOR).map((e) => e.to)
  const line = (s: Node) => {
    const why =
      s.type === OUTCOME ? (Snapshot.inbound(snap, s.id, SERVES).length > 0 ? ` ← ${Snapshot.inbound(snap, s.id, SERVES).map((e) => e.from).sort().join(", ")}` : " ← no journey")
      : s.type === CONSTRAINT ? (s.edges.some((e) => e.type === BOUNDS) ? ` → ${s.edges.filter((e) => e.type === BOUNDS).map((e) => e.to).join(", ")}` : "")
      : s.props.answer !== undefined ? ` (answered: ${String(s.props.answer)})` : " (open)"
    return `  ${pad(KEYWORD[s.type] ?? s.type)} ${text(s)}  # ${s.id}${why}`
  }
  return [
    `${intent.id} ${String(intent.props.title)}`,
    `  ${pad("Status")} ${String(intent.props.status)}`,
    ...(fors.length > 0 ? [`  ${pad("For")} ${fors.map(name).join(", ")}  # ${fors.join(", ")}`] : []),
    ...statementsOf(snap, intent.id).map(line),
  ].join("\n")
}
```
In `render`, before `const parts`:
```ts
  // Intents only when asked for: an intent, or one of its statements, in focus.
  const shownIntents = focus === undefined ? [] : intents(snap).filter((i) => focus.has(i.id) || statementsOf(snap, i.id).some((s) => focus.has(s.id)))
```
and start `parts` with them: `const parts = [...shownIntents.map((i) => renderIntent(snap, i)), ...shown.map((c) => renderScenario(snap, c))]`. The "States without scenarios" logic stays as it is. A statement in focus matches no scenario edges, so `shown` is empty, as the test expects.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/plugin-gherkin && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS. The existing agenda and render tests are unchanged, because the new items appear only when intents or journeys with outcomes exist.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/plugin-gherkin && git commit -m "feat(gherkin): intents on the agenda and in render

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Audit warnings — uncovered and unserving

**Files:**
- Modify: `packages/audit/src/index.ts`
- Modify: `packages/cli/src/commands.ts:125-150` (the docstring only: warnings never set the exit code)
- Test: `packages/audit/test/audit.test.ts`

**Interfaces:**
- Produces `Report.warnings: ReadonlyArray<{ kind: "uncovered"; outcome: string; text: string } | { kind: "unserving"; journey: string; name: string }>`. `summary` prints one line per warning and adds `· n uncovered · m unserving` to its count line.

- [ ] **Step 1: Write the failing test** (append to `audit.test.ts`)

```ts
describe("intent coverage", () => {
  const o = (id: string) => ({ id, type: "gherkin/outcome", props: { text: `outcome ${id}` }, edges: [] })
  const j = (id: string, serves: ReadonlyArray<string> = []) => ({ id, type: "gherkin/journey", props: { name: `journey ${id}` }, edges: serves.map((to) => ({ type: "gherkin/serves", to })) })
  test("an outcome no journey serves is uncovered, a journey serving none is unserving: warnings, not problems", () => {
    const r = audit(Snapshot.make([o("O-0001"), o("O-0002"), j("J-0001", ["O-0001"]), j("J-0002")] as never), [])
    expect(r.warnings).toEqual([{ kind: "uncovered", outcome: "O-0002", text: "outcome O-0002" }, { kind: "unserving", journey: "J-0002", name: "journey J-0002" }])
    expect(r.problems).toEqual([])
    expect(summary(r)).toContain("uncovered           O-0002 outcome O-0002")
    expect(summary(r).split("\n").at(-1)).toBe("0 built · 0 planned · 0 untagged · 0 planned-but-tagged · 0 orphan · 1 uncovered · 1 unserving")
  })
  test("without outcomes no journey is unserving", () => {
    expect(audit(Snapshot.make([j("J-0001")] as never), []).warnings).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/audit && mise x -- bun test`
Expected: FAIL (`r.warnings` is undefined).

- [ ] **Step 3: Implement** (in `packages/audit/src/index.ts`)

```ts
export type Warning = { readonly kind: "uncovered"; readonly outcome: string; readonly text: string } | { readonly kind: "unserving"; readonly journey: string; readonly name: string }
```
Add `readonly warnings: ReadonlyArray<Warning>` to `Report`. In `audit`, compute:
```ts
  const of = (type: string) => [...snap.nodes.values()].filter((n) => n.type === type).sort((a, b) => a.id.localeCompare(b.id))
  const outcomes = of("gherkin/outcome")
  const journeys = of("gherkin/journey")
  const served = new Set(journeys.flatMap((j) => j.edges.filter((e) => e.type === "gherkin/serves").map((e) => e.to)))
  // Warnings until every journey serves an outcome (plan b): verify stays green meanwhile.
  const warnings: Array<Warning> = [
    ...outcomes.filter((o) => !served.has(o.id)).map((o): Warning => ({ kind: "uncovered", outcome: o.id, text: String(o.props.text ?? "") })),
    ...(outcomes.length === 0 ? [] : journeys.filter((j) => !j.edges.some((e) => e.type === "gherkin/serves")).map((j): Warning => ({ kind: "unserving", journey: j.id, name: String(j.props.name ?? "") }))),
  ]
```
and return `{ scenarios: report, problems: [...], warnings }`. In `summary`:
```ts
  const warned = (k: Warning["kind"]) => r.warnings.filter((w) => w.kind === k).length
  return [
    ...r.problems.map(/* unchanged */),
    ...r.warnings.map((w) => (w.kind === "uncovered" ? `uncovered           ${w.outcome} ${w.text}` : `unserving           ${w.journey} ${w.name}`)),
    `${built} built · ${planned} planned · ${count("untagged")} untagged · ${count("planned-but-tagged")} planned-but-tagged · ${count("orphan")} orphan${r.warnings.length > 0 ? ` · ${warned("uncovered")} uncovered · ${warned("unserving")} unserving` : ""}`,
  ].join("\n")
```
The CLI's exit code stays tied to `report.problems` only. Change the `auditCmd` docstring to: `/** Every scenario against its @scenario tags, and intent coverage: JSON (or --summary), exit 1 on problems (warnings never fail it); --scenario for one scenario. */`

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/audit && mise x -- bun test && mise x -- bunx tsc --noEmit -p . && cd ../cli && mise x -- bunx tsc --noEmit -p .`
Expected: PASS. The existing test `summary(...)` line is unchanged, since a graph without outcomes gets no suffix.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/audit packages/cli && git commit -m "feat(audit): uncovered outcomes and unserving journeys, as warnings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The Intents view (a nav item)

**Files:**
- Create: `packages/plugin-gherkin/src/intents.ts`
- Modify: `packages/plugin-gherkin/src/views.ts` (append `IntentsView`)
- Modify: `packages/plugin-gherkin/src/index.ts` (`views`, `surfaces`, entity `commands`, `act` handles agent `intents`, `act` params gain `text`)
- Modify: `docs/superpowers/specs/2026-10-02-intents-in-the-graph-design.md` (the view keys: `a`, `k`, `q`, `e`, `⏎`, `d`)
- Test: `packages/plugin-gherkin/test/intents.test.ts`

**Interfaces:**
- Consumes: the tools (Task 3), `renderScenario` and `journeyName`.
- Produces `intentsView(snap) → { summary: StatsData, rows: Array<{ id: string; cells: { item: string; cover: string }; text: string }>, details: Record<string, string> }`. Row ids are node ids. Intents come first by id, each followed by its statements.
- Produces the nav surface `{ kind: "nav", name: "intents", view: "intents", label: "Intents" }`.
- `act({ agent: "intents", action, rows, text })`. The actions are `open`, `add-outcome`, `add-constraint`, `ask-question`, `edit`, `answer` and `remove`; `remove`'s text is the chosen id, `yes` or `no`. Each write goes through `Entities.command` on the row's own kind (the host's write pipeline), and `act` then reloads the view.

- [ ] **Step 1: Write the failing tests** (append to `intents.test.ts`)

```ts
import { intentsView } from "../src/intents"

describe("the Intents view", () => {
  const s = graph(
    n("I-0001", "intent", { title: "Plans", status: "draft", problem: "Visitors leave." }, [["has", "O-0001"], ["has", "O-0002"], ["has", "K-0001"], ["has", "Q-0001"]]),
    n("O-0001", "outcome", { text: "A visitor picks a plan" }),
    n("O-0002", "outcome", { text: "A receipt arrives" }),
    n("K-0001", "constraint", { text: "Prices never hide fees" }, [["bounds", "J-0001"]]),
    n("Q-0001", "question", { text: "Is there a yearly plan?" }),
    n("J-0001", "journey", { name: "Checkout" }, [["serves", "O-0001"]]),
  )
  test("rows: the intent, then its statements with their coverage; the summary counts outcomes and uncovered ones", () => {
    const v = intentsView(s)
    expect(v.rows.map((r) => [r.id, r.cells.item, r.cells.cover])).toEqual([
      ["I-0001", "◈ I-0001 Plans", "draft"],
      ["O-0001", "  ▸ A visitor picks a plan", "Checkout"],
      ["O-0002", "  ▸ A receipt arrives", "◇ no journey"],
      ["K-0001", "  ▪ Prices never hide fees", "bounds Checkout"],
      ["Q-0001", "  ? Is there a yearly plan?", "open"],
    ])
    // A row's text prefills e (edit): the title or the statement.
    expect(v.rows[1]!.text).toBe("A visitor picks a plan")
    expect(v.summary.items).toEqual([{ label: "intent", value: "1" }, { label: "outcomes", value: "2" }, { label: "uncovered", value: "1", tone: "attention" }])
    expect(v.details["O-0001"]).toContain("**Served by** Checkout (J-0001)")
    expect(v.details["I-0001"]).toContain("Visitors leave.")
  })
})

describe("the Intents view, through the host", () => {
  test("open fills it; a adds an outcome, e rewords it, ⏎ answers a question, d removes after yes", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* call("add-intent", { title: "Plans" })
        yield* call("ask-question", { intent: "I-0001", text: "Is there a yearly plan?" })
        const act = (action: string, rows: ReadonlyArray<string> = [], text?: string) => PluginHost.use((h) => h.invoke("gherkin", "act", { agent: "intents", action, rows, ...(text !== undefined ? { text } : {}) }))
        const notices = [
          yield* act("open"),
          yield* act("add-outcome", ["I-0001"], "A visitor picks a plan"),
          yield* act("edit", ["O-0001"], "A visitor picks a plan quickly"),
          yield* act("answer", ["Q-0001"], "No yearly plan"),
          yield* act("remove", ["O-0001"], "no"),
          yield* act("remove", ["O-0001"], "yes"),
          yield* act("answer", ["I-0001"], "x"),
        ]
        const snap = yield* GraphStore.use((g) => g.snapshot)
        return { notices: notices.map((x) => (x as { notice: string }).notice), o: snap.nodes.has("O-0001"), q: snap.nodes.get("Q-0001")?.props }
      }),
    )
    expect(got.notices).toEqual(["1 intent: 0 outcomes, 0 uncovered", "created O-0001 in I-0001", "updated O-0001", "answered Q-0001", "kept O-0001", "removed O-0001", "I-0001 is not a question"])
    expect(got.o).toBe(false)
    expect(got.q).toEqual({ text: "Is there a yearly plan?", answer: "No yearly plan" })
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd packages/plugin-gherkin && mise x -- bun test test/intents.test.ts`
Expected: FAIL (`../src/intents` is not found).

- [ ] **Step 3: Implement `intents.ts`**

```ts
import { type Node, Snapshot } from "@zarg/graph/pure"
import { BOUNDS, CONSTRAINT, IN, intents, journeyName, OUTCOME, QUESTION, SERVES, statementsOf, text } from "./model"
import { renderScenario } from "./render"

const GLYPH: Readonly<Record<string, string>> = { [OUTCOME]: "▸", [CONSTRAINT]: "▪", [QUESTION]: "?" }
const nameOf = (snap: Snapshot.Snapshot, id: string) => { const n = snap.nodes.get(id); return n === undefined ? id : String(n.props.name ?? n.props.title ?? id) }

/** The Intents view's data: every intent and its statements as rows, with coverage; a detail per row. */
export const intentsView = (snap: Snapshot.Snapshot) => {
  const all = [...intents(snap)].sort((a, b) => a.id.localeCompare(b.id))
  const rows: Array<{ id: string; cells: { item: string; cover: string }; text: string }> = []
  const details: Record<string, string> = {}
  const servedBy = (o: string) => Snapshot.inbound(snap, o, SERVES).map((e) => e.from).sort()
  const scenariosOf = (journey: string) => Snapshot.inbound(snap, journey, IN).map((e) => e.from).sort()
  for (const i of all) {
    const own = statementsOf(snap, i.id)
    rows.push({ id: i.id, cells: { item: `◈ ${i.id} ${String(i.props.title)}`, cover: String(i.props.status) }, text: String(i.props.title) })
    details[i.id] = [`**${i.id} ${String(i.props.title)}** · ${String(i.props.status)}`, "", String(i.props.problem ?? "No problem written yet."), "", `${own.length} statement${own.length === 1 ? "" : "s"}.`].join("\n")
    for (const s of own) {
      const cover =
        s.type === OUTCOME ? (servedBy(s.id).length > 0 ? servedBy(s.id).map((j) => nameOf(snap, j)).join(", ") : "◇ no journey")
        : s.type === CONSTRAINT ? (s.edges.some((e) => e.type === BOUNDS) ? `bounds ${s.edges.filter((e) => e.type === BOUNDS).map((e) => nameOf(snap, e.to)).join(", ")}` : "bounds nothing")
        : s.props.answer !== undefined ? "answered" : "open"
      rows.push({ id: s.id, cells: { item: `  ${GLYPH[s.type] ?? "·"} ${text(s)}`, cover }, text: text(s) })
      details[s.id] = detailOf(snap, s, servedBy(s.id), scenariosOf)
    }
  }
  const outcomes = all.flatMap((i) => statementsOf(snap, i.id)).filter((s) => s.type === OUTCOME)
  const uncovered = outcomes.filter((o) => servedBy(o.id).length === 0).length
  return {
    summary: { items: [{ label: all.length === 1 ? "intent" : "intents", value: String(all.length) }, { label: outcomes.length === 1 ? "outcome" : "outcomes", value: String(outcomes.length) }, { label: "uncovered", value: String(uncovered), ...(uncovered > 0 ? { tone: "attention" as const } : {}) }] },
    rows,
    details,
  }
}

/** A statement in full: the journeys that serve it (or what it bounds), each journey's scenarios as Gherkin. */
const detailOf = (snap: Snapshot.Snapshot, s: Node, served: ReadonlyArray<string>, scenariosOf: (j: string) => ReadonlyArray<string>) => {
  const head = `**${s.id}** ${text(s)}`
  if (s.type === QUESTION) return [head, "", s.props.answer !== undefined ? `**Answer** ${String(s.props.answer)}` : "Open: ⏎ answers it."].join("\n")
  const targets = s.type === OUTCOME ? served : s.edges.filter((e) => e.type === BOUNDS).map((e) => e.to)
  const label = s.type === OUTCOME ? "Served by" : "Bounds"
  if (targets.length === 0) return [head, "", s.type === OUTCOME ? "No journey serves it yet." : "It bounds nothing yet."].join("\n")
  const blocks = targets.map((t) => {
    const n = snap.nodes.get(t)
    const ids = n?.type === "gherkin/journey" ? scenariosOf(t) : [t]
    const gherkin = ids.flatMap((id) => { const c = snap.nodes.get(id); return c === undefined ? [] : [renderScenario(snap, c)] }).join("\n\n")
    return [`### ${n === undefined ? t : n.type === "gherkin/journey" ? journeyName(n) : String(n.props.title)} (${t})`, "```gherkin", gherkin || "No scenarios yet.", "```"].join("\n")
  })
  return [head, "", `**${label}** ${targets.map((t) => `${nameOf(snap, t)} (${t})`).join(", ")}`, "", ...blocks].join("\n")
}
```

`views.ts` (append):
```ts
/** Intents, above the agents (the `intents` nav item): every intent and its statements, with what serves them. */
export const IntentsView = defineView("intents", {
  summary: { kind: "stats", role: "summary" },
  list: {
    kind: "table",
    role: "primary",
    title: "",
    columns: [{ id: "item", label: "intent", filter: "search" }, { id: "cover", label: "served by", filter: "none" }],
    actions: [
      { id: "open", label: "Refresh", key: "r", on: "none" },
      { id: "add-outcome", label: "Outcome", key: "a", on: "row", input: "an outcome: one result for its users" },
      { id: "add-constraint", label: "Constraint", key: "k", on: "row", input: "a constraint: one rule that must hold" },
      { id: "ask-question", label: "Question", key: "q", on: "row", input: "an open question" },
      { id: "edit", label: "Edit", key: "e", on: "row", input: "the new wording" },
      { id: "answer", label: "Answer", on: "row", default: true, input: "the answer" },
      { id: "remove", label: "Remove", key: "d", on: "row", choices: [{ id: "yes", label: "Remove it" }, { id: "no", label: "Keep it" }] },
    ],
  },
  // The highlighted row in full: a statement with its journeys and their scenarios, beside the list.
  detail: { kind: "text", role: "pinned", title: "", follows: "list", beside: "list" },
})
```
Before writing this, check the reserved keys: `grep -rn "RESERVED\|reserved" packages/view/src/keys*.ts packages/view-tui/src/*.ts | head`. `x` is reserved in the terminal (`packages/view/src/keys.ts`), so remove is `d`. If `a`, `k`, `q`, `e` or `d` is reserved too, pick the nearest free letter and record a ledger ruling. The test exercises `act` by action id, not by key.

`index.ts`:
- import `IntentsView` and `intentsView`, and add `Entities` from `@zarg/plugin-sdk`;
- `views: [JourneysView, IntentsView]`;
- `surfaces`: add `{ kind: "nav", name: "intents", view: "intents", label: "Intents" }`;
- entity kinds gain commands:
  - intent: `commands: { "add-outcome": "add-outcome", "add-constraint": "add-constraint", "ask-question": "ask-question", edit: "edit-intent", remove: "remove" }`;
  - outcome: `commands: { edit: "edit-outcome", remove: "remove" }`;
  - constraint: `commands: { edit: "edit-constraint", remove: "remove" }`;
  - question: `commands: { edit: "edit-question", answer: "answer-question", remove: "remove" }`;
- `act` params: add `text: Schema.optionalKey(Schema.String)`; change its doc to `"The Journeys and Intents views: open (or refresh) one; on Intents, add, edit, answer or remove a row."`;
- in `make`: `const entities_ = yield* Entities`;
- replace `act`:
```ts
      act: ({ agent, action, rows, text }: { agent: string; action: string; rows: ReadonlyArray<string>; text?: string }) =>
        Effect.gen(function* () {
          if (agent === "intents") return yield* intentsAct(action, rows[0], text)
          if (agent !== "journeys") return { notice: `gherkin has no agent ${agent}` }
          // … the Journeys body, unchanged …
        }).pipe(Effect.mapError((e) => new PluginFailure({ tag: "ViewError", message: String((e as { message?: unknown }).message ?? e) }))),
```
with, inside `make`:
```ts
    const showIntents = Effect.gen(function* () {
      const v = intentsView(yield* snap)
      yield* views.set("intents", IntentsView, "summary", v.summary)
      yield* views.set("intents", IntentsView, "list", { rows: v.rows })
      yield* views.set("intents", IntentsView, "detail", { markdown: "No intents yet. Tell zarg what the product is for, or add one with gherkin/add-intent.", rows: v.details })
      const outcomes = v.summary.items[1]!.value
      return `${v.summary.items[0]!.value} ${v.summary.items[0]!.label}: ${outcomes} ${v.summary.items[1]!.label}, ${v.summary.items[2]!.value} uncovered`
    })
    const KIND: Readonly<Record<string, string>> = { [INTENT]: "intent", [OUTCOME]: "outcome", [CONSTRAINT]: "constraint", [QUESTION]: "question" }
    /** An Intents row's action: a command on the row's own kind (the host's write pipeline: tools, lints, commit), then the view again. */
    const intentsAct = (action: string, row: string | undefined, text: string | undefined) =>
      Effect.gen(function* () {
        if (action === "open") return { notice: yield* showIntents }
        const node = row === undefined ? undefined : (yield* snap).nodes.get(row)
        const kind = node === undefined ? undefined : KIND[node.type]
        if (node === undefined || kind === undefined) return { notice: `${row ?? "nothing"} is not an intent or a statement` }
        const ref = `gherkin/${kind}:${node.id}`
        const intent = node.type === INTENT ? node.id : intentOf(yield* snap, node.id)
        const run = (r: string, name: string, args: Record<string, unknown>) =>
          Effect.map(entities_.command(r, name, args), (res) => String((res as { message?: unknown }).message ?? "done"))
        const notice: string = yield* (() => {
          if (action === "add-outcome" || action === "add-constraint" || action === "ask-question")
            return intent === undefined || text === undefined ? Effect.succeed("nothing to add") : run(`gherkin/intent:${intent}`, action, { intent, text })
          if (action === "edit") return text === undefined ? Effect.succeed("nothing to change") : run(ref, "edit", node.type === INTENT ? { title: text } : { text })
          if (action === "answer") return node.type !== QUESTION ? Effect.succeed(`${node.id} is not a question`) : text === undefined ? Effect.succeed("no answer given") : run(ref, "answer", { answer: text })
          if (action === "remove") return text !== "yes" ? Effect.succeed(`kept ${node.id}`) : run(ref, "remove", {})
          return Effect.succeed(`no action ${action}`)
        })()
        yield* showIntents
        return { notice }
      }).pipe(Effect.catch((e: { readonly message?: string }) => Effect.succeed({ notice: e.message ?? String(e) })))
```
Import `CONSTRAINT, INTENT, intentOf, OUTCOME, QUESTION` from `./model`. A failed command (a lint refusal, for example) comes back as its message in the notice, so the operator sees why.

Update the spec's Authoring bullets under "In the Intent view":
- `a` adds an outcome under the highlighted row's intent, `k` a constraint, `q` a question;
- `e` rewords the highlighted row;
- `⏎` on a question answers it;
- `d` removes it after a Remove/Keep choice (`x` is the terminal's own key).

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/plugin-gherkin && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS. The host-level test covers Review Focus 1: the command re-enters gherkin while its own `act` runs, and the write lands.

If the re-entrant call deadlocks (the test times out), don't work around it inside gherkin. Read how `packages/plugin/src/runtime` dispatches calls to one plugin process. Look for a per-process mutex or a single in-flight request, then fix it there, so a plugin's call through a power can be served while it waits. Use superpowers:systematic-debugging, and record a ledger ruling.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/plugin-gherkin docs/superpowers/specs/2026-10-02-intents-in-the-graph-design.md && git commit -m "feat(gherkin): the Intents view: statements with their coverage, edited in place

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Migration — I-0001 in the graph, "what next" from uncovered outcomes, the file gone

**Files:**
- Graph: `.zarg/graph` via `zarg tool call` (never by hand)
- Modify: `packages/agent-zarg/src/intent.ts` (replace `nextGoals` with `nextOutcomes`)
- Modify: `packages/agent-zarg/src/zarg.ts:60-70`
- Modify: `packages/agent-rehearse/src/index.ts:36` (drop `"intent/**"` from `fs.read`)
- Delete: `intent/zarg.md`
- Test: `packages/agent-zarg/test/intent.test.ts` (rewrite)
- Docs: `AGENTS.md`, `.claude/skills/zarg-drive/SKILL.md`, `docs/taxonomy.md`

**Interfaces:**
- Produces `nextOutcomes(snap: Snapshot.Snapshot): ReadonlyArray<NextOption>`. It returns the uncovered outcomes in id order: `{ id: "O-0003", label: <text>, why: <intent title>, task: "Find or shape the journey that delivers O-0003 (<text>), then link it with link {edge: \"serves\", journey, outcome: \"O-0003\"}." }`.

- [ ] **Step 1: Write the failing test** (`packages/agent-zarg/test/intent.test.ts`, replacing its content)

```ts
import { expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { nextOutcomes } from "../src/intent"

test("what next: the outcomes no journey serves, in id order, each with its intent", () => {
  const snap = Snapshot.make([
    { id: "I-0001", type: "gherkin/intent", props: { title: "zarg", status: "accepted" }, edges: [{ type: "gherkin/has", to: "O-0002" }, { type: "gherkin/has", to: "O-0001" }, { type: "gherkin/has", to: "O-0003" }] },
    { id: "O-0001", type: "gherkin/outcome", props: { text: "One conversation" }, edges: [] },
    { id: "O-0002", type: "gherkin/outcome", props: { text: "The agent leads" }, edges: [] },
    { id: "O-0003", type: "gherkin/outcome", props: { text: "Served already" }, edges: [] },
    { id: "J-0001", type: "gherkin/journey", props: { name: "Talk" }, edges: [{ type: "gherkin/serves", to: "O-0003" }] },
  ] as never)
  expect(nextOutcomes(snap)).toEqual([
    { id: "O-0001", label: "One conversation", why: "zarg", task: 'Find or shape the journey that delivers O-0001 (One conversation), then link it with link {edge: "serves", journey, outcome: "O-0001"}.' },
    { id: "O-0002", label: "The agent leads", why: "zarg", task: 'Find or shape the journey that delivers O-0002 (The agent leads), then link it with link {edge: "serves", journey, outcome: "O-0002"}.' },
  ])
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/agent-zarg && mise x -- bun test test/intent.test.ts`
Expected: FAIL (`nextOutcomes` is not exported).

- [ ] **Step 3: Implement**

`packages/agent-zarg/src/intent.ts` (whole file):
```ts
import type { Snapshot } from "@zarg/graph/pure"

/** One way to go on, offered when nothing is open: what the operator picks becomes their word to the driver. */
export interface NextOption {
  readonly id: string
  readonly label: string
  readonly why?: string
  readonly task: string
}

/** What next: every outcome no journey serves, in id order, with the intent it belongs to. */
export const nextOutcomes = (snap: Snapshot.Snapshot): ReadonlyArray<NextOption> => {
  const nodes = [...snap.nodes.values()]
  const served = new Set(nodes.flatMap((n) => (n.type === "gherkin/journey" ? n.edges.filter((e) => e.type === "gherkin/serves").map((e) => e.to) : [])))
  const intentOf = (id: string) => nodes.find((n) => n.type === "gherkin/intent" && n.edges.some((e) => e.type === "gherkin/has" && e.to === id))
  return nodes
    .filter((n) => n.type === "gherkin/outcome" && !served.has(n.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((o) => {
      const text = String(o.props.text ?? o.id)
      const intent = intentOf(o.id)
      return { id: o.id, label: text, ...(intent !== undefined ? { why: String(intent.props.title ?? intent.id) } : {}), task: `Find or shape the journey that delivers ${o.id} (${text}), then link it with link {edge: "serves", journey, outcome: "${o.id}"}.` }
    })
}
```
Check the `@zarg/graph` dependency first: `grep -n '"@zarg/graph"' packages/agent-zarg/package.json`. If it is missing, run `cd packages/agent-zarg && mise x -- bun add @zarg/graph@workspace:*`.

`zarg.ts`: import `nextOutcomes`, and drop `nextGoals` plus any of `existsSync`, `readdirSync` and `readFileSync` that are now unused. Replace `whatNext`:
```ts
    // What zarg offers when nothing is open: the outcomes no journey serves; with none, where journeys start.
    const whatNext = (focus: ReadonlySet<string> | undefined) =>
      Effect.gen(function* () {
        const snap = yield* store.snapshot
        const outcomes = nextOutcomes(snap)
        if (outcomes.length > 0) return outcomes
        return [...snap.nodes.values()]
          .filter((n) => n.type === "gherkin/state" && n.props.entry === true && (focus === undefined || focus.has(n.id)))
          .map((n): NextOption => ({ id: n.id, label: String(n.props.text ?? n.id), task: `Work on the journey that starts at "${String(n.props.text ?? n.id)}" (${n.id}).` }))
      })
```

`packages/agent-rehearse/src/index.ts:36`: `fs: { read: [".zarg/rehearse/**"], write: [".zarg/rehearse/**"] }`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/agent-zarg && mise x -- bun test && mise x -- bunx tsc --noEmit -p . && cd ../agent-rehearse && mise x -- bun test`
Expected: PASS.

- [ ] **Step 5: Write I-0001 into the graph**

Write the calls into a scratch file (not committed), then apply them in order through the CLI. Each must answer with a `message`; stop at the first failure and fix its wording (the lints say why).

```bash
S=/tmp/claude-1000/-home-demiurge-Git-zarg-v2/$(ls -t /tmp/claude-1000/-home-demiurge-Git-zarg-v2 | head -1)/scratchpad
cat > $S/i-0001.jsonl <<'EOF'
["gherkin/add-intent", {"title": "zarg, a harness where you only talk about intent", "status": "accepted", "problem": "Building software with coding agents still means driving every step yourself: writing requirements, splitting work, prompting implementation, reviewing code, re-explaining context that got lost. The agent's memory is a stream of chat that grows until it is truncated, so decisions drift and work is redone. What the operator actually owns is the intent: what the product should do and why. Everything after that is mechanical enough to automate, but no harness separates the two."}]
["gherkin/link", {"edge": "for", "intent": "I-0001", "persona": {"id": "P-0001"}}]
["gherkin/link", {"edge": "for", "intent": "I-0001", "persona": {"id": "P-0002"}}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "The operator talks to one agent about intent; it resumes where they left off."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "Nothing important lives only in a chat transcript."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "The agent asks one question at a time, with options, recommending one."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "With nothing open, the agent asks what is next, with options from what is missing."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "Requirements, rehearsals, plans and code follow the operator's words on their own."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "Whatever cannot follow on its own comes back to the operator as a question."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "Small judgments use small, fast models; local models come first."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "The operator sees every agent's work live and can stop any of it."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "A restart resumes work instead of redoing it."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "A pending question survives a restart."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "Working, verified, committed code traces back through a scenario to an intent."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "The operator sets up model providers and plugins in the terminal app, without editing files."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "The agent keeps the intents from the conversation; the operator never edits them by hand."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "Intents become requirements on their own, each traced to its intent."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "Testers roleplay each persona over the journeys that persona acts in."}]
["gherkin/add-outcome", {"intent": "I-0001", "text": "The operator sees which code each scenario owns."}]
["gherkin/add-constraint", {"intent": "I-0001", "text": "Secrets never reach a model, a log or the wire."}]
["gherkin/add-constraint", {"intent": "I-0001", "text": "Plugins run only with what the operator granted."}]
["gherkin/add-constraint", {"intent": "I-0001", "text": "Requirements change only with the operator's say."}]
["gherkin/add-constraint", {"intent": "I-0001", "text": "Code changes only to match the requirements."}]
["gherkin/add-constraint", {"intent": "I-0001", "text": "Git is required; work lands on the operator's branch."}]
["gherkin/add-constraint", {"intent": "I-0001", "text": "Only conflicts zarg cannot settle reach the operator."}]
["gherkin/add-constraint", {"intent": "I-0001", "text": "The operator's uncommitted edits are never overwritten."}]
["gherkin/ask-question", {"intent": "I-0001", "text": "How is an intent accepted: the operator's explicit yes, or implied once its requirements follow?"}]
["gherkin/ask-question", {"intent": "I-0001", "text": "How many testers rehearse, how often, and which findings reach the operator?"}]
["gherkin/ask-question", {"intent": "I-0001", "text": "Several conversations with different focuses: one agent with many threads, or one per focus?"}]
EOF
mise run build:plugins
while IFS= read -r line; do
  name=$(echo "$line" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')
  params=$(echo "$line" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[1]))')
  out=$(mise run -q zarg -- tool call "$name" "$params") || { echo "FAILED: $name $params"; echo "$out"; break; }
  echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["message"])'
done < $S/i-0001.jsonl
```
Expected: `created I-0001`, `linked I-0001 for P-0001`, `linked I-0001 for P-0002`, `created O-0001 in I-0001` … `created O-0015 in I-0001`, `created K-0001 in I-0001` … `created K-0007 in I-0001`, `created Q-0001 in I-0001` … `created Q-0003 in I-0001`. The lints may warn about "and" in a few statements; warnings don't refuse.

Then validate:
```bash
mise run -q zarg -- render --focus I-0001 | head -30
mise run -q zarg -- audit --summary | tail -1
```
Expected:
- render shows `I-0001 zarg, a harness where you only talk about intent`, `Status     accepted`, `For        Operator, CLI actor`, 15 `Outcome` lines (each `← no journey`), 7 `Constraint` lines and 3 `Question … (open)` lines;
- the audit's last line ends with `· 15 uncovered · 5 unserving`, and its exit code is 0.

- [ ] **Step 6: Delete the file; update the docs**

```bash
git rm intent/zarg.md
```
- `AGENTS.md`:
  - in the `packages/frontmatter` bullet, replace `Intents keep \`personas\` and \`next\` there, plans \`scenario\`, \`hash\`, \`title\`.` with `Plans keep \`scenario\`, \`hash\`, \`title\` there.`;
  - in the `packages/reconcile` bullet, replace `(see \`intent/zarg.md\`)` with `(see intent I-0001 in the graph)`;
  - in the Terms line, replace `goals` with `outcomes`;
  - in the `packages/plugin-gherkin` bullet, append: `; intents (\`I-\`) with their outcomes (\`O-\`), constraints (\`K-\`) and questions (\`Q-\`): journeys serve outcomes, constraints bound journeys or scenarios; its Intents view is a nav item (\`a\` outcome, \`k\` constraint, \`q\` question, \`e\` edit, ⏎ answer, \`d\` remove)`.
- `.claude/skills/zarg-drive/SKILL.md`, the Personas bullet: replace `(listed in \`intent/zarg.md\`)` with `(the intent's \`for\` personas: \`render --focus I-0001\`)`. Then add a model bullet after the persona bullet: `- An **intent** (\`I-NNNN\`) says what the product is for: its **outcomes** (\`O-\`), **constraints** (\`K-\`) and open **questions** (\`Q-\`), one sentence each. A journey **serves** outcomes (\`link {edge: "serves", journey, outcome}\`); a constraint **bounds** a journey or a scenario. The agenda asks which journey delivers an uncovered outcome.`
- `docs/taxonomy.md`, the Audit row: `every outcome served, every journey serving one (\`uncovered\`, \`unserving\`: warnings until every journey serves an outcome)`.

- [ ] **Step 7: Verify and commit (the graph and the code together)**

```bash
mise run build:plugins && mise run verify && git add -A .zarg/graph packages/agent-zarg packages/agent-rehearse AGENTS.md .claude/skills/zarg-drive/SKILL.md docs/taxonomy.md && git rm -q --cached intent/zarg.md 2>/dev/null; git commit -m "req: intent I-0001 in the graph; what next reads uncovered outcomes; intent/zarg.md goes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Expected: verify is green; the audit warns 15 uncovered and 5 unserving.

---

## Self-Review

- **Spec coverage:**
  - Model: Tasks 2 and 3.
  - Edges, including "exactly one intent": Tasks 1, 3 and 4.
  - Tools: Task 3.
  - Versions: Task 2 (the host versions graph kinds by node hash; plans and feedback pin `gherkin/outcome:O-…@v`).
  - Agenda: Task 5 (grouped, with the ruling below).
  - Audit: Task 6.
  - Authoring:
    - conversation: the driver already writes the graph through tools, and the new tools join `tool list` automatically;
    - the view: Task 7.
  - View: Task 7. "Plans in flight for it" moves to plan (b), which gives plans their `serves` field.
  - Migration: Task 8. The `serves` links for J-0001..5 come from plan (b), and `audit` becomes strict there.
- **Rulings made here:**
  - Uncovered and unserving are one agenda item each, not one per node. The inbox flood earlier proved per-node items unusable. Cost if wrong: the agenda shows a list instead of single items.
  - The view's keys: `a`/`k`/`q`, and `d` (not `x`, which the terminal keeps) with a Remove/Keep choice (view actions can't take both `choices` and `input`). The spec is updated in Task 7.
  - Intents render only when in focus, so the full `render` and its tests are unchanged.

---
