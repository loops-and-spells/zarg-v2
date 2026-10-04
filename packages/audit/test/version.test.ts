import { expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { scenarioVersion } from "../src/version"

const n = (id: string, type: string, props: Record<string, unknown>, edges: ReadonlyArray<[string, string]> = []) => ({ id, type, props, edges: edges.map(([t, to]) => ({ type: t, to })) })
const snap = Snapshot.make([
  n("ST-1", "gherkin/state", { text: "a" }),
  n("ST-2", "gherkin/state", { text: "b" }),
  n("P-1", "gherkin/persona", { name: "Op", kind: "human", text: "x" }),
  n("S-1", "gherkin/scenario", { title: "t", when: "w", planned: true }, [["gherkin/arrives", "ST-1"], ["gherkin/then", "ST-2"], ["gherkin/by", "P-1"], ["gherkin/in", "J-1"]]),
] as never)

test("the version hashes what a tester reads (not planned, not the journeys); a reworded state changes it", () => {
  const v = scenarioVersion(snap, "S-1")!
  expect(v).toMatch(/^[0-9a-f]{12}$/)
  const unplanned = Snapshot.make([...snap.nodes.values()].map((x) => (x.id === "S-1" ? { ...x, props: { title: "t", when: "w" } } : x)) as never)
  expect(scenarioVersion(unplanned, "S-1")).toBe(v)
  const reworded = Snapshot.make([...snap.nodes.values()].map((x) => (x.id === "ST-2" ? { ...x, props: { text: "c" } } : x)) as never)
  expect(scenarioVersion(reworded, "S-1")).not.toBe(v)
  expect(scenarioVersion(snap, "ST-1")).toBeUndefined()
})
