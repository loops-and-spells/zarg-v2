// packages/plugin-gherkin/test/stories.test.ts
import { describe, expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { ARRIVES, SCENARIO, IN, JOURNEY, STATE, THEN } from "../src/model"
import { planStories, stepView } from "../src/stories"

const st = (id: string, text: string, props: Record<string, unknown> = {}) => ({ id, type: STATE, props: { text, ...props }, edges: [] })
const cd = (id: string, when: string, from: string, to: ReadonlyArray<string>) => ({
  id,
  type: SCENARIO,
  props: { title: `scenario ${id}`, when },
  edges: [{ type: ARRIVES, to: from }, ...to.map((t) => ({ type: THEN, to: t }))],
})
// S1 (entry) -A-> S2; S2 forks: -B-> S3, -C-> S4; S3 -D-> S5; S4 -E-> S5; S5 -F-> S6 (terminal)
const graph = Snapshot.make([
  st("S1", "the shop is open", { entry: true }), st("S2", "the cart is shown"), st("S3", "the payment form is shown"),
  st("S4", "the cart is empty"), st("S5", "the receipt is shown"), st("S6", "the visitor leaves", { terminal: true }),
  cd("A", "the visitor opens the cart", "S1", ["S2"]), cd("B", "the visitor checks out", "S2", ["S3"]), cd("C", "the visitor clears the cart", "S2", ["S4"]),
  cd("D", "the visitor pays", "S3", ["S5"]), cd("E", "the visitor asks for a receipt", "S4", ["S5"]), cd("F", "the visitor closes the tab", "S5", ["S6"]),
] as never)

const pairs = (stories: ReadonlyArray<ReadonlyArray<string>>) =>
  new Set(stories.flatMap((s) => s.flatMap((c, i) => [...(i > 0 ? [`${s[i - 1]}>${c}`] : []), ...(i > 1 ? [`${s[i - 2]}>${s[i - 1]}>${c}`] : [])])))

describe("stories", () => {
  test("edge-pair stories run root to leaf and cover every step and every consecutive pair", () => {
    const { stories, unreachable } = planStories(graph, "edge-pair")
    expect(unreachable).toBe(0)
    expect(stories.every((s) => s[0] === "A" && s.at(-1) === "F")).toBe(true)
    const covered = pairs(stories)
    for (const r of ["A>B", "A>C", "B>D", "C>E", "D>F", "E>F", "A>B>D", "A>C>E", "B>D>F", "C>E>F"]) expect(covered.has(r)).toBe(true)
    expect(stories.length).toBe(2)
  })

  test("a loopback is left out; stories still end at leaves", () => {
    const loop = Snapshot.make([...graph.nodes.values(), cd("G", "the visitor goes back", "S5", ["S2"])] as never)
    const { stories } = planStories(loop, "edge-pair")
    expect(stories.length).toBeGreaterThan(0)
    expect(stories.every((s) => new Set(s).size === s.length)).toBe(true)
  })

  test("a root scenario with nothing after it is a story; scenarios no root reaches are counted as unreachable", () => {
    const g = Snapshot.make([
      st("S1", "the shop is open", { entry: true }), st("S2", "the shop is closed"),
      st("H", "the hall is shown"), st("P", "the porch is shown"),
      cd("A", "the visitor closes the shop", "S1", ["S2"]),
      cd("X", "the visitor steps out", "H", ["P"]), cd("Y", "the visitor steps in", "P", ["H"]),
    ] as never)
    expect(planStories(g, "edge-pair")).toEqual({ stories: [["A"]], unreachable: 2 })
  })

  test("teleport visits each scenario once, alone; focus keeps only stories through it", () => {
    expect(planStories(graph, "teleport").stories).toEqual([["A"], ["B"], ["C"], ["D"], ["E"], ["F"]])
    expect(planStories(graph, "edge-pair", new Set(["E"])).stories.every((s) => s.includes("E"))).toBe(true)
  })

  test("a step shows its Given, When, Thens, how it was reached, the fork after it, and whether it has a failure case", () => {
    expect(stepView(graph, "B", "A")).toEqual({
      scenario: "B",
      title: "scenario B",
      given: "the cart is shown",
      when: "the visitor checks out",
      thens: ["the payment form is shown"],
      via: { scenario: "A", when: "the visitor opens the cart" },
      fork: [{ scenario: "D", when: "the visitor pays" }],
      hasFailure: true,
      journeys: [],
      by: [],
      // The states' ids, so an agent proposing changes names them (reuse, unlink) rather than guessing.
      ids: { given: expect.any(String), context: [], thens: [expect.any(String)] },
    })
    expect(stepView(graph, "D")?.hasFailure).toBe(false)
    // Its journeys and personas, by name (none here).
    expect(stepView(graph, "B")).toMatchObject({ journeys: [], by: [] })
    const tagged = Snapshot.make([
      ...graph.nodes.values(),
      { id: "J-0001", type: "gherkin/journey", props: { name: "Checkout" }, edges: [] },
      { id: "P-0001", type: "gherkin/persona", props: { name: "Visitor", kind: "human", text: "x" }, edges: [] },
    ].map((n) => (n.id === "B" ? { ...n, edges: [...n.edges, { type: "gherkin/in", to: "J-0001" }, { type: "gherkin/by", to: "P-0001" }] } : n)) as never)
    expect(stepView(tagged, "B")).toMatchObject({ journeys: ["Checkout"], by: ["Visitor"] })
    expect(stepView(graph, "nope")).toBeUndefined()
  })
})

describe("journey stories", () => {
  // Checkout: A, B, C, D. After: E, F. X is in no journey. C leads into After (to E), D too (to F).
  const jn = (id: string, name: string) => ({ id, type: JOURNEY, props: { name }, edges: [] })
  const inJ = (n: { id: string; type: string; props: unknown; edges: ReadonlyArray<{ type: string; to: string }> }, j: string) => ({ ...n, edges: [...n.edges, { type: IN, to: j }] })
  const nodes = [...graph.nodes.values()]
  const scenario = (id: string) => nodes.find((n) => n.id === id)! as never
  const journeys = Snapshot.make([
    ...nodes.filter((n) => n.type === STATE),
    jn("J-0001", "Checkout"), jn("J-0002", "After"),
    ...["A", "B", "C", "D"].map((c) => inJ(scenario(c), "J-0001")),
    ...["E", "F"].map((c) => inJ(scenario(c), "J-0002")),
    cd("X", "the visitor comes back", "S6", ["S1"]),
  ] as never)
  const key = (s: ReadonlyArray<string>) => s.join(">")

  test("each journey's stories stay inside it and cover its steps and pairs; a seam story per step between journeys; a lone scenario alone", () => {
    const { stories, unreachable } = planStories(journeys, "journey")
    expect(new Set(stories.map(key))).toEqual(new Set(["A>B>D", "A>C", "E>F", "C>E", "D>F", "X"]))
    expect(unreachable).toBe(0)
  })
  test("focus keeps the stories through a focused scenario", () => {
    expect(new Set(planStories(journeys, "journey", new Set(["E"])).stories.map(key))).toEqual(new Set(["E>F", "C>E"]))
  })
  test("a scenario in two journeys is walked in both", () => {
    const both = Snapshot.make([...journeys.nodes.values()].map((n) => (n.id === "F" ? { ...n, edges: [...n.edges, { type: IN, to: "J-0001" }] } : n)) as never)
    const stories = planStories(both, "journey").stories.map(key)
    expect(stories).toContain("A>B>D>F")
    expect(stories).toContain("E>F")
    expect(stories).not.toContain("D>F")
  })
})

test("a step says whether its scenario is planned (not built yet)", () => {
  const snap = Snapshot.make([
    { id: "ST-1", type: "gherkin/state", props: { text: "a" }, edges: [] },
    { id: "S-1", type: "gherkin/scenario", props: { title: "t", when: "w", planned: true }, edges: [{ type: "gherkin/arrives", to: "ST-1" }] },
    { id: "S-2", type: "gherkin/scenario", props: { title: "t", when: "w" }, edges: [{ type: "gherkin/arrives", to: "ST-1" }] },
  ] as never)
  expect([stepView(snap, "S-1")?.planned, stepView(snap, "S-2")?.planned]).toEqual([true, undefined])
})
