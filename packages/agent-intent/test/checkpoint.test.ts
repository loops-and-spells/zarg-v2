import { expect, test } from "bun:test"
import { due, EMPTY, type JourneyInfo, type Statement } from "../src/checkpoint"

const intent = { id: "I-0001", title: "Plans" }
const o = (id: string, version: string, journeys: ReadonlyArray<string> = []): Statement => ({ id, kind: "outcome", text: `text ${id}`, version, intent, journeys })
const j = (id: string, version: string, serves: ReadonlyArray<string> = []): JourneyInfo => ({ id, name: `journey ${id}`, version, scenarios: [], serves })

test("new, changed and answered statements are due; the same version planned or asked is not", () => {
  const cp = { statements: { "O-0002": { version: "v2", state: "planned" as const }, "O-0003": { version: "old", state: "planned" as const }, "O-0004": { version: "v4", state: "asked" as const, topic: "T-1" }, "O-0005": { version: "v5", state: "asked" as const, decision: "Add to Checkout" } }, journeys: {} }
  const ids = due([o("O-0001", "v1"), o("O-0002", "v2"), o("O-0003", "new"), o("O-0004", "v4"), o("O-0005", "v5")], [], cp, true).map((d) => (d.kind === "statement" ? d.statement.id : d.kind))
  expect(ids).toEqual(["O-0001", "O-0003", "O-0005"])
})
test("a statement in the checkpoint but no longer in the graph is removed", () => {
  expect(due([], [], { statements: { "O-0009": { version: "v", state: "planned" } }, journeys: {} }, false)).toEqual([{ kind: "removed", id: "O-0009" }])
})
test("an unserving journey is due once per version, and only while outcomes exist", () => {
  expect(due([], [j("J-0001", "v1"), j("J-0002", "v1", ["O-0001"])], EMPTY, true).map((d) => (d.kind === "journey" ? d.journey.id : d.kind))).toEqual(["J-0001"])
  expect(due([], [j("J-0001", "v1")], { statements: {}, journeys: { "J-0001": { version: "v1", state: "nothing" } } }, true)).toEqual([])
  expect(due([], [j("J-0001", "v1")], EMPTY, false)).toEqual([])
})
test("removed statements come first; journeys wait while any statement is due or has a plan on its way", () => {
  const kinds = (cp: Parameters<typeof due>[2], gone: ReadonlySet<string> = new Set()) => due([o("O-0001", "v1")], [j("J-0001", "v1")], cp, true, gone).map((d) => d.kind)
  expect(kinds({ statements: { "O-0009": { version: "v", state: "planned" } }, journeys: {} })).toEqual(["removed", "statement"])
  // O-0001 planned, its plan still on its way: the journey waits (the plan may link it).
  expect(kinds({ statements: { "O-0001": { version: "v1", state: "planned", plans: ["B-1"] } }, journeys: {} })).toEqual([])
  // Its plan was dropped: O-0001 is due again; the journey still waits.
  expect(kinds({ statements: { "O-0001": { version: "v1", state: "planned", plans: ["B-1"] } }, journeys: {} }, new Set(["B-1"]))).toEqual(["statement"])
  // Settled (nothing to change): the journey's turn.
  expect(kinds({ statements: { "O-0001": { version: "v1", state: "nothing" } }, journeys: {} })).toEqual(["journey"])
})
test("a statement whose serving journeys changed since its round is due again: its plans were drafted against other journeys", () => {
  const cp = { statements: { "O-0001": { version: "v1", state: "planned" as const, plans: ["B-2"] }, "O-0002": { version: "v2", state: "nothing" as const, journeys: ["J-0001"] } }, journeys: {} }
  const ids = due([o("O-0001", "v1", ["J-0001"]), o("O-0002", "v2", ["J-0001"])], [], cp, true).map((d) => (d.kind === "statement" ? d.statement.id : d.kind))
  expect(ids).toEqual(["O-0001"])
})
test("an outcome a journey serves whose plans were all dropped is settled, not drafted again: the operator turned the change down", () => {
  const cp = { statements: { "O-0001": { version: "v1", state: "planned" as const, plans: ["B-1"], journeys: ["J-0001"] }, "O-0002": { version: "v2", state: "planned" as const, plans: ["B-2"] } }, journeys: {} }
  const ids = due([o("O-0001", "v1", ["J-0001"]), o("O-0002", "v2")], [], cp, true, new Set(["B-1", "B-2"])).map((d) => (d.kind === "statement" ? d.statement.id : d.kind))
  // O-0002, served by nothing, still needs a round.
  expect(ids).toEqual(["O-0002"])
})
