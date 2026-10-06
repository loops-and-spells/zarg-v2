import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GraphStore } from "@zarg/graph"
import { diff, Snapshot } from "@zarg/graph/pure"
import { statementOwner } from "../src/lints"
import { agenda } from "../src/agenda"
import { render } from "../src/render"
import { intentsView } from "../src/intents"
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
  // @scenario S-0100 S-0101 S-0102
  test("add an intent and its statements; each statement is in its intent; a question is answered into an outcome", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* visitor
        const m = (r: { message: string }) => r.message
        const out = [
          m(yield* call("add-intent", { title: "Plans for visitors", problem: "Visitors leave the pricing page." })),
          m(yield* call("add-outcome", { intent: "I-0001", text: "A visitor picks a plan in one minute" })),
          // An entity ref (as Entities gives it, with its version) names the same node.
          m(yield* call("add-constraint", { intent: "gherkin/intent:I-0001@0123456789ab", text: "Prices never hide fees" })),
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
    expect(got.wrong).toContain("K-0001 is a gherkin/constraint, not a gherkin/outcome")
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

describe("the Intents view", () => {
  const s = graph(
    n("I-0001", "intent", { title: "Plans", status: "draft", problem: "Visitors leave." }, [["has", "O-0001"], ["has", "O-0002"], ["has", "K-0001"], ["has", "Q-0001"]]),
    n("O-0001", "outcome", { text: "A visitor picks a plan" }),
    n("O-0002", "outcome", { text: "A receipt arrives" }),
    n("K-0001", "constraint", { text: "Prices never hide fees" }, [["bounds", "J-0001"]]),
    n("Q-0001", "question", { text: "Is there a yearly plan?" }),
    n("J-0001", "journey", { name: "Checkout" }, [["serves", "O-0001"]]),
  )
  // @scenario S-0099
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
  test("a statement's detail lists the plans serving it, by lane", () => {
    const v = intentsView(s, [{ id: "B-12", title: "Shorten pricing", status: "backlog", serves: "gherkin/outcome:O-0002@abcdefabcdef" }, { id: "B-13", title: "Other", status: "ready", serves: "gherkin/outcome:O-0009@abcdefabcdef" }])
    expect(v.details["O-0002"]).toContain("**Plans**\n- B-12 backlog: Shorten pricing")
    expect(v.details["O-0001"]).not.toContain("B-13")
  })
})

describe("the Intents view, through the host", () => {
  // @scenario S-0099 S-0100 S-0101
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

describe("removing what a constraint bounds", () => {
  test("a scenario a constraint bounds is removed with the bounds edge to it", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* call("add-persona", { name: "Visitor", kind: "human", text: "Someone choosing a plan." })
        yield* call("add-state", { text: "the visitor is on the home page", entry: true })
        yield* call("add-scenario", { title: "Visitor opens pricing", when: "the visitor opens pricing", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the plan picker is shown" }] })
        yield* call("add-intent", { title: "Plans" })
        yield* call("add-constraint", { intent: "I-0001", text: "Prices never hide fees" })
        yield* call("link", { edge: "bounds", constraint: "K-0001", scenario: "S-0001" })
        const removed = (yield* call("remove", { id: "S-0001" })).message
        const snap = yield* GraphStore.use((g) => g.snapshot)
        return { removed, gone: !snap.nodes.has("S-0001"), k: snap.nodes.get("K-0001")?.edges }
      }),
    )
    expect(got).toEqual({ removed: "removed S-0001", gone: true, k: [] })
  })
})
