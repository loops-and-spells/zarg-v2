import { expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { flowOf } from "../src/flow"

const st = (id: string) => ({ id, type: "gherkin/state", props: { text: id }, edges: [] })
const sc = (id: string, from: string, to: ReadonlyArray<string>, j = "J-1") => ({
  id,
  type: "gherkin/scenario",
  props: { title: id, when: "w" },
  edges: [{ type: "gherkin/arrives", to: from }, ...to.map((t) => ({ type: "gherkin/then", to: t })), { type: "gherkin/in", to: j }],
})
const snap = Snapshot.make([
  st("ST-1"), st("ST-2"), st("ST-3"), st("ST-8"), st("ST-9"), { id: "J-1", type: "gherkin/journey", props: { name: "J" }, edges: [] },
  sc("S-1", "ST-1", ["ST-2"]), sc("S-2", "ST-2", ["ST-3"]), sc("S-3", "ST-2", ["ST-1"]), sc("S-4", "ST-3", ["ST-2"]), sc("S-9", "ST-9", ["ST-8"]),
] as never)

// Every member has a predecessor (a loop), so the walk starts at the first by id. S-4 leads to ST-2: S-2 is on the path (back), S-3 is not (next).
test("depth first from the start; branches in order; loops back; lone scenarios apart", () => {
  expect(flowOf(snap, "J-1")).toEqual({
    steps: [
      { id: "S-1", next: ["S-2", "S-3"], back: [] },
      { id: "S-2", next: ["S-4"], back: [] },
      { id: "S-4", next: ["S-3"], back: ["S-2"] },
      { id: "S-3", next: [], back: ["S-1"] },
    ],
    apart: ["S-9"],
  })
  expect(flowOf(snap, "J-404")).toEqual({ steps: [], apart: [] })
})
