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
  const base = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), card("UX-1", "S-1", ["S-2"]), card("UX-2", "S-2", ["S-3"]))

  test("added and changed cards are affected; untouched ones are not", () => {
    const after = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), card("UX-1", "S-1", ["S-2"], "the user taps"), card("UX-2", "S-2", ["S-3"]), card("UX-3", "S-3", ["S-1"]))
    expect(affectedCards(base, after)).toEqual({ cards: ["UX-1", "UX-3"], removed: [] })
  })

  test("a reworded state affects every card that arrives at or leads to it", () => {
    const after = snap(state("S-1", "home"), state("S-2", "basket"), state("S-3", "paid"), card("UX-1", "S-1", ["S-2"]), card("UX-2", "S-2", ["S-3"]))
    expect(affectedCards(base, after)).toEqual({ cards: ["UX-1", "UX-2"], removed: [] })
  })

  test("removed cards are listed separately; nothing changed means nothing affected", () => {
    const after = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), card("UX-1", "S-1", ["S-2"]))
    expect(affectedCards(base, after)).toEqual({ cards: [], removed: ["UX-2"] })
    expect(affectedCards(base, base)).toEqual({ cards: [], removed: [] })
  })
})
