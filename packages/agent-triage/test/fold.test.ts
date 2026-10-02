import { describe, expect, test } from "bun:test"
import { dependencies, fold, merge, type Unit } from "../src/fold"

const u = (scenario: string, changes: Unit["changes"]): Unit => ({ scenario, title: scenario, summary: `fix ${scenario}`, changes, answers: [] })
const units = [
  u("S-0001", [{ tool: "edit-state", params: { id: "ST-0002", text: "asked once" } }, { tool: "link", params: { scenario: "S-0001", edge: "then", state: { text: "a new state" } } }]),
  u("S-0002", [{ tool: "link", params: { scenario: "S-0002", edge: "then", state: { text: "a new state" } } }]),
  u("S-0003", [{ tool: "edit-scenario", params: { id: "S-0003", when: "it runs" } }]),
  u("S-0004", [{ tool: "edit-state", params: { id: "ST-0002", text: "asked twice" } }]),
]

describe("folding a round", () => {
  test("dependencies: a later unit naming what an earlier one created or changed", () => {
    expect(dependencies(units)).toEqual([[1, 0], [3, 0]])
  })
  test("a new scenario's states count as made: a later unit reusing one by text depends on it", () => {
    const added = [u("NEW", [{ tool: "add-scenario", params: { title: "T", when: "w", arrives: { id: "ST-0001" }, then: [{ text: "the scenario is shown" }] } }]), u("S-0009", [{ tool: "link", params: { scenario: "S-0009", edge: "arrives", state: { text: "the scenario is shown" } } }])]
    expect(dependencies(added)).toEqual([[1, 0]])
  })
  test("the model's groups, ordered: a group waits on the group its units depend on", () => {
    const plans = fold(units, dependencies(units), [
      { title: "States", steps: ["s"], scenarios: ["S-0001", "S-0004"] },
      { title: "Links", steps: ["l"], scenarios: ["S-0002"] },
      { title: "When", steps: ["w"], scenarios: ["S-0003"] },
    ])
    expect(plans.map((p) => [p.title, p.units, p.after])).toEqual([["States", [0, 3], []], ["Links", [1], [0]], ["When", [2], []]])
  })
  test("groups repaired: a scenario twice or left out still lands in exactly one plan", () => {
    const plans = fold(units, dependencies(units), [{ title: "A", steps: [], scenarios: ["S-0001", "S-0002"] }, { title: "B", steps: [], scenarios: ["S-0002", "S-9999"] }])
    expect(plans.flatMap((p) => p.units).sort()).toEqual([0, 1, 2, 3])
    expect(plans.every((p) => p.units.length > 0)).toBe(true)
  })
  test("plans that would wait on each other merge", () => {
    const plans = fold(units, [[1, 0], [0, 1]], [{ title: "A", steps: [], scenarios: ["S-0001"] }, { title: "B", steps: [], scenarios: ["S-0002"] }])
    expect(plans.find((p) => p.units.includes(0))!.units).toEqual([0, 1])
  })
  test("at most 5 scenarios a plan, split in draft order", () => {
    const many = Array.from({ length: 7 }, (_, i) => u(`S-01${i}`, []))
    expect(fold(many, [], [{ title: "All", steps: [], scenarios: many.map((x) => x.scenario) }]).map((p) => p.units.length)).toEqual([5, 2])
  })
  test("without the model: the dependency components", () => {
    expect(fold(units, dependencies(units)).map((p) => p.units)).toEqual([[0, 1, 3], [2]])
  })
  test("a group judged not atomic splits into its dependency components", () => {
    const plans = fold(units, dependencies(units), [{ title: "All", steps: [], scenarios: units.map((x) => x.scenario) }], () => false)
    expect(plans.map((p) => p.units)).toEqual([[0, 1, 3], [2]])
  })
  test("a plan that fails its dry-run merges into the plan it waits on; the rest re-point", () => {
    const plans = fold(units, dependencies(units), [
      { title: "States", steps: ["s"], scenarios: ["S-0001", "S-0004"] },
      { title: "Links", steps: ["l"], scenarios: ["S-0002"] },
      { title: "When", steps: ["w"], scenarios: ["S-0003"] },
    ])
    const merged = merge(plans, 1)
    expect(merged.map((p) => [p.title, p.units, p.after, p.steps])).toEqual([["States", [0, 1, 3], [], ["s", "l"]], ["When", [2], [], ["w"]]])
    // One that waits on none merges into the one before it.
    expect(merge(plans, 2).map((p) => p.units)).toEqual([[0, 3], [1, 2]])
  })
  test("plans come in dependency order: a plan never waits on one after it", () => {
    const three = [u("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001", when: "w" } }]), u("S-0002", [{ tool: "add-state", params: { text: "S" } }]), u("S-0003", [{ tool: "link", params: { scenario: "S-0003", edge: "then", state: { text: "S" } } }])]
    const plans = fold(three, dependencies(three), [{ title: "One and three", steps: [], scenarios: ["S-0001", "S-0003"] }, { title: "Two", steps: [], scenarios: ["S-0002"] }])
    expect(plans.map((p) => [p.units, p.after])).toEqual([[[1], []], [[0, 2], [0]]])
  })
  test("a merge keeps the order: the failing plan joins the latest plan it waits on, never a cycle", () => {
    const plans = [
      { title: "Q", steps: [], units: [0], after: [] },
      { title: "Y", steps: [], units: [1], after: [0] },
      { title: "K", steps: [], units: [2], after: [0, 1] },
    ]
    const merged = merge(plans, 2)
    expect(merged.map((p) => [p.units, p.after])).toEqual([[[0], []], [[1, 2], [0]]])
    expect(merged.every((p, k) => p.after.every((j) => j < k))).toBe(true)
  })
})
