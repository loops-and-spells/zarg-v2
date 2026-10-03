import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GraphStore } from "@zarg/graph"
import { diff, Snapshot } from "@zarg/graph/pure"
import { statementOwner } from "../src/lints"
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

  test("statementOwner: a statement two intents claim, or none, is an error", () => {
    const intent = (id: string, has: ReadonlyArray<string>) => ({ id, type: "gherkin/intent", props: { title: id, status: "draft" }, edges: has.map((to) => ({ type: "gherkin/has", to })) })
    const outcome = (id: string) => ({ id, type: "gherkin/outcome", props: { text: id }, edges: [] })
    const before = Snapshot.make([intent("I-1", ["O-1"]), intent("I-2", []), outcome("O-1")] as never)
    const lint = (after: Snapshot.Snapshot) => statementOwner({ before, after, diff: diff(before, after) }).map((f) => f.message)
    expect(lint(Snapshot.make([intent("I-1", ["O-1"]), intent("I-2", ["O-1"]), outcome("O-1")] as never))).toEqual(["O-1 belongs to I-1, I-2; a statement belongs to exactly one intent"])
    expect(lint(Snapshot.make([intent("I-1", []), intent("I-2", []), outcome("O-1")] as never))).toEqual(["O-1 belongs to no intent"])
    expect(lint(before)).toEqual([])
  })
})
