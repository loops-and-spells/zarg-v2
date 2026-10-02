import { describe, expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph"
import { affectedScenarios } from "../src/affected"

const state = (id: string, text: string) => ({ id, type: "gherkin/state", props: { text }, edges: [] })
const scenario = (id: string, arrives: string, then: ReadonlyArray<string>, when = "the user acts") => ({
  id,
  type: "gherkin/scenario",
  props: { title: id, when },
  edges: [{ type: "gherkin/arrives", to: arrives }, ...then.map((t) => ({ type: "gherkin/then", to: t }))],
})
const snap = (...nodes: ReadonlyArray<ReturnType<typeof state> | ReturnType<typeof scenario>>) => Snapshot.make(nodes as never)

describe("affectedScenarios", () => {
  const base = snap(state("ST-1", "home"), state("ST-2", "cart"), state("ST-3", "paid"), scenario("S-1", "ST-1", ["ST-2"]), scenario("S-2", "ST-2", ["ST-3"]))

  test("added and changed scenarios are affected; untouched ones are not", () => {
    const after = snap(state("ST-1", "home"), state("ST-2", "cart"), state("ST-3", "paid"), scenario("S-1", "ST-1", ["ST-2"], "the user taps"), scenario("S-2", "ST-2", ["ST-3"]), scenario("S-3", "ST-3", ["ST-1"]))
    expect(affectedScenarios(base, after)).toEqual({ scenarios: ["S-1", "S-3"], removed: [] })
  })

  test("a reworded state affects every scenario that arrives at or leads to it", () => {
    const after = snap(state("ST-1", "home"), state("ST-2", "basket"), state("ST-3", "paid"), scenario("S-1", "ST-1", ["ST-2"]), scenario("S-2", "ST-2", ["ST-3"]))
    expect(affectedScenarios(base, after)).toEqual({ scenarios: ["S-1", "S-2"], removed: [] })
  })

  test("removed scenarios are listed separately; nothing changed means nothing affected", () => {
    const after = snap(state("ST-1", "home"), state("ST-2", "cart"), state("ST-3", "paid"), scenario("S-1", "ST-1", ["ST-2"]))
    expect(affectedScenarios(base, after)).toEqual({ scenarios: [], removed: ["S-2"] })
    expect(affectedScenarios(base, base)).toEqual({ scenarios: [], removed: [] })
  })
  test("a change to planned alone affects no scenario", () => {
    const planned = (c: ReturnType<typeof scenario>) => ({ ...c, props: { ...c.props, planned: true } })
    const after = snap(state("ST-1", "home"), state("ST-2", "cart"), state("ST-3", "paid"), planned(scenario("S-1", "ST-1", ["ST-2"])), scenario("S-2", "ST-2", ["ST-3"]))
    expect(affectedScenarios(base, after).scenarios).toEqual([])
    const reworded = snap(state("ST-1", "home"), state("ST-2", "cart"), state("ST-3", "paid"), planned(scenario("S-1", "ST-1", ["ST-2"], "the user taps")), scenario("S-2", "ST-2", ["ST-3"]))
    expect(affectedScenarios(after, reworded).scenarios).toEqual(["S-1"])
  })
})

test("a persona's text change affects no scenario; a scenario's by change affects that scenario", () => {
  const persona = (text: string) => ({ id: "P-0001", type: "gherkin/persona", props: { name: "Operator", kind: "human", text }, edges: [] })
  const scenario = (by: ReadonlyArray<string>) => ({ id: "S-0001", type: "gherkin/scenario", props: { title: "t", when: "w" }, edges: [...by.map((to) => ({ type: "gherkin/by", to })), { type: "gherkin/arrives", to: "ST-0001" }, { type: "gherkin/then", to: "ST-0002" }] })
  const s1 = { id: "ST-0001", type: "gherkin/state", props: { text: "a" }, edges: [] }
  const s2 = { id: "ST-0002", type: "gherkin/state", props: { text: "b" }, edges: [] }
  const mk = (...nodes: ReadonlyArray<unknown>) => Snapshot.make(nodes as never)
  expect(affectedScenarios(mk(persona("x"), scenario(["P-0001"]), s1, s2), mk(persona("y"), scenario(["P-0001"]), s1, s2)).scenarios).toEqual([])
  expect(affectedScenarios(mk(persona("x"), scenario([]), s1, s2), mk(persona("x"), scenario(["P-0001"]), s1, s2)).scenarios).toEqual(["S-0001"])
})
