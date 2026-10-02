import { describe, expect, test } from "bun:test"
import { canonical, diff, hash, Put, Remove, Snapshot } from "../src"
import { card, state } from "./fixtures"

const base = Snapshot.make([
  state("ST-0001", "home"),
  state("ST-0002", "picker"),
  state("ST-0003", "form"),
  card("S-0001", "clicks pricing", "ST-0001", ["ST-0002"]),
  card("S-0002", "picks free", "ST-0002", ["ST-0003"]),
])

describe("snapshot", () => {
  test("indexes inbound edges", () => {
    expect(Snapshot.inbound(base, "ST-0002").map((e) => [e.from, e.edge.type])).toEqual([
      ["S-0001", "t/then"],
      ["S-0002", "t/arrives"],
    ])
  })

  test("neighbors never walks back up a by edge: a persona every card names is a leaf, not a hub", () => {
    const card = (id: string, state: string) => ({ id, type: "gherkin/card", props: {}, edges: [{ type: "gherkin/by", to: "P-0001" }, { type: "gherkin/arrives", to: state }] })
    const snap = Snapshot.make([
      { id: "P-0001", type: "gherkin/persona", props: {}, edges: [] },
      { id: "ST-0001", type: "gherkin/state", props: {}, edges: [] },
      { id: "ST-0009", type: "gherkin/state", props: {}, edges: [] },
      card("S-0001", "ST-0001"),
      card("S-0009", "ST-0009"),
    ] as never)
    // S-0001 sees its persona, but not the unrelated S-0009 that shares it.
    expect(Snapshot.neighbors(snap, "S-0001", 3)).toEqual(["P-0001", "S-0001", "ST-0001"])
    // From the persona itself, its cards are still one hop away.
    expect(Snapshot.neighbors(snap, "P-0001", 1)).toEqual(["P-0001", "S-0001", "S-0009"])
  })

  test("neighbors walks both directions up to k hops", () => {
    expect(Snapshot.neighbors(base, "ST-0002", 1)).toEqual(["S-0001", "S-0002", "ST-0002"])
    expect(Snapshot.neighbors(base, "ST-0002", 2)).toEqual(["S-0001", "S-0002", "ST-0001", "ST-0002", "ST-0003"])
  })

  test("nextId continues the highest number for a prefix", () => {
    expect(Snapshot.nextId(base, "S")).toBe("S-0003")
    expect(Snapshot.nextId(Snapshot.empty, "ST")).toBe("ST-0001")
  })

  test("danglingEdges finds edges to missing nodes", () => {
    const next = Snapshot.applyChanges(base, [Remove("ST-0003")])
    expect(Snapshot.danglingEdges(next)).toEqual([{ from: "S-0002", edge: { type: "t/then", to: "ST-0003" } }])
  })
})

describe("canonical", () => {
  test("sorts keys and ends with a newline, so equal nodes hash equal", () => {
    const a = { id: "ST-0001", type: "t/state", props: { b: 1, a: 2 }, edges: [] }
    const b = { edges: [], props: { a: 2, b: 1 }, type: "t/state", id: "ST-0001" }
    expect(canonical(a)).toBe(canonical(b))
    expect(canonical(a).endsWith("}\n")).toBe(true)
    expect(hash(a)).toBe(hash(b))
  })
})

describe("diff", () => {
  test("reports added, removed and changed nodes keyed by id", () => {
    const next = Snapshot.applyChanges(base, [
      Put(state("ST-0002", "plans listed")),
      Put(state("ST-0004", "payment")),
      Remove("S-0002"),
    ])
    const d = diff(base, next)
    expect(d.added.map((n) => n.id)).toEqual(["ST-0004"])
    expect(d.removed.map((n) => n.id)).toEqual(["S-0002"])
    expect(d.changed.map((c) => c.id)).toEqual(["ST-0002"])
    expect(d.changed[0]?.props).toEqual([{ op: "replace", path: "/text", value: "plans listed" }])
  })

  test("reports edge changes on a changed node", () => {
    const next = Snapshot.applyChanges(base, [Put(card("S-0002", "picks free", "ST-0002", ["ST-0001"]))])
    const edges = diff(base, next).changed[0]?.edges
    expect(edges?.added).toEqual([{ type: "t/then", to: "ST-0001" }])
    expect(edges?.removed).toEqual([{ type: "t/then", to: "ST-0003" }])
  })

  test("identical snapshots have an empty diff", () => {
    expect(diff(base, Snapshot.make([...base.nodes.values()]))).toEqual({ added: [], removed: [], changed: [] })
  })
})
