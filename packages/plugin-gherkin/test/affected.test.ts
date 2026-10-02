import { describe, expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph"
import { affectedCards } from "../src/affected"

const state = (id: string, text: string) => ({ id, type: "gherkin/state", props: { text }, edges: [] })
const card = (id: string, arrives: string, then: ReadonlyArray<string>, when = "the user acts") => ({
  id,
  type: "gherkin/card",
  props: { title: id, when },
  edges: [{ type: "gherkin/arrives", to: arrives }, ...then.map((t) => ({ type: "gherkin/then", to: t }))],
})
const snap = (...nodes: ReadonlyArray<ReturnType<typeof state> | ReturnType<typeof card>>) => Snapshot.make(nodes as never)

describe("affectedCards", () => {
  const base = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), card("C-1", "S-1", ["S-2"]), card("C-2", "S-2", ["S-3"]))

  test("added and changed cards are affected; untouched ones are not", () => {
    const after = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), card("C-1", "S-1", ["S-2"], "the user taps"), card("C-2", "S-2", ["S-3"]), card("C-3", "S-3", ["S-1"]))
    expect(affectedCards(base, after)).toEqual({ cards: ["C-1", "C-3"], removed: [] })
  })

  test("a reworded state affects every card that arrives at or leads to it", () => {
    const after = snap(state("S-1", "home"), state("S-2", "basket"), state("S-3", "paid"), card("C-1", "S-1", ["S-2"]), card("C-2", "S-2", ["S-3"]))
    expect(affectedCards(base, after)).toEqual({ cards: ["C-1", "C-2"], removed: [] })
  })

  test("removed cards are listed separately; nothing changed means nothing affected", () => {
    const after = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), card("C-1", "S-1", ["S-2"]))
    expect(affectedCards(base, after)).toEqual({ cards: [], removed: ["C-2"] })
    expect(affectedCards(base, base)).toEqual({ cards: [], removed: [] })
  })
  test("a change to planned alone affects no card", () => {
    const planned = (c: ReturnType<typeof card>) => ({ ...c, props: { ...c.props, planned: true } })
    const after = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), planned(card("C-1", "S-1", ["S-2"])), card("C-2", "S-2", ["S-3"]))
    expect(affectedCards(base, after).cards).toEqual([])
    const reworded = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), planned(card("C-1", "S-1", ["S-2"], "the user taps")), card("C-2", "S-2", ["S-3"]))
    expect(affectedCards(after, reworded).cards).toEqual(["C-1"])
  })
})

test("a persona's text change affects no card; a card's by change affects that card", () => {
  const persona = (text: string) => ({ id: "P-0001", type: "gherkin/persona", props: { name: "Operator", kind: "human", text }, edges: [] })
  const card = (by: ReadonlyArray<string>) => ({ id: "C-0001", type: "gherkin/card", props: { title: "t", when: "w" }, edges: [...by.map((to) => ({ type: "gherkin/by", to })), { type: "gherkin/arrives", to: "S-0001" }, { type: "gherkin/then", to: "S-0002" }] })
  const s1 = { id: "S-0001", type: "gherkin/state", props: { text: "a" }, edges: [] }
  const s2 = { id: "S-0002", type: "gherkin/state", props: { text: "b" }, edges: [] }
  const mk = (...nodes: ReadonlyArray<unknown>) => Snapshot.make(nodes as never)
  expect(affectedCards(mk(persona("x"), card(["P-0001"]), s1, s2), mk(persona("y"), card(["P-0001"]), s1, s2)).cards).toEqual([])
  expect(affectedCards(mk(persona("x"), card([]), s1, s2), mk(persona("x"), card(["P-0001"]), s1, s2)).cards).toEqual(["C-0001"])
})
