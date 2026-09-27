// packages/plugin-gherkin/test/stories.test.ts
import { describe, expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { ARRIVES, CARD, STATE, THEN } from "../src/model"
import { planStories, stepView } from "../src/stories"

const st = (id: string, text: string, props: Record<string, unknown> = {}) => ({ id, type: STATE, props: { text, ...props }, edges: [] })
const cd = (id: string, when: string, from: string, to: ReadonlyArray<string>) => ({
  id,
  type: CARD,
  props: { title: `card ${id}`, when },
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

  test("teleport visits each card once, alone; focus keeps only stories through it", () => {
    expect(planStories(graph, "teleport").stories).toEqual([["A"], ["B"], ["C"], ["D"], ["E"], ["F"]])
    expect(planStories(graph, "edge-pair", new Set(["E"])).stories.every((s) => s.includes("E"))).toBe(true)
  })

  test("a step shows its Given, When, Thens, how it was reached, the fork after it, and whether it has a failure case", () => {
    expect(stepView(graph, "B", "A")).toEqual({
      card: "B",
      title: "card B",
      given: "the cart is shown",
      when: "the visitor checks out",
      thens: ["the payment form is shown"],
      via: { card: "A", when: "the visitor opens the cart" },
      fork: [{ card: "D", when: "the visitor pays" }],
      hasFailure: true,
    })
    expect(stepView(graph, "D")?.hasFailure).toBe(false)
    expect(stepView(graph, "nope")).toBeUndefined()
  })
})
