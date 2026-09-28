import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Snapshot } from "@zarg/graph"
import { type Kind, makeEntities } from "../src/server/entities"

const kind = (over: Partial<Kind> = {}): Kind => ({ type: "board/item", owner: "board", ownerGraph: false, doc: "", tone: "accent", glyph: "▦", commands: {}, data: {}, ops: new Set(["get", "label", "version", "query"]), graph: false, ...over })
const backend = (k: Kind, provider: (p: { op: string; ids?: ReadonlyArray<string> }) => unknown, snap = Snapshot.empty) => {
  const calls: Array<string> = []
  const e = makeEntities({
    kinds: new Map([[k.type, k]]),
    provider: (_o, p) => (calls.push(`${p.op}:${(p.ids ?? []).join(",")}`), Effect.succeed(provider(p))),
    write: () => Effect.succeed(null),
    invoke: () => Effect.succeed(null),
    snapshot: Effect.succeed(snap),
    render: () => Effect.succeed(""),
    scopeOf: () => ({ read: [], command: [] }),
  })
  return { e, calls }
}
const items = { "B-1": { title: "First" }, "B-2": { title: "Second" } } as Record<string, { title: string }>
const serve = (p: { op: string; ids?: ReadonlyArray<string> }) =>
  p.op === "query" ? ["B-1", "B-2"] : p.op === "get" ? (p.ids ?? []).flatMap((id) => (items[id] ? [{ id, data: items[id] }] : [])) : p.op === "label" ? (p.ids ?? []).map((id) => ({ id, text: items[id]!.title })) : (p.ids ?? []).map((id) => ({ id, version: "v1" }))

describe("queries", () => {
  test("an owner's own query is its answer: the host does not filter or rank it again", async () => {
    const { e } = backend(kind(), serve)
    const out = await Effect.runPromise(e.query({ type: "board/item", text: "no word here matches" }))
    expect(out.map((x) => x.id)).toEqual(["B-1", "B-2"])
  })
  test("a graph query filters by props and applies the limit before fetching", async () => {
    const snap = Snapshot.make(["a", "b", "c"].map((n, i) => ({ id: `T-000${i + 1}`, type: "notes/topic", props: { name: n, tier: i === 2 ? "pro" : "free" }, edges: [] })) as never)
    const g = kind({ type: "notes/topic", owner: "notes", ownerGraph: true, graph: true, ops: new Set(["label"]) })
    const { e, calls } = backend(g, (p) => (p.ids ?? []).map((id) => ({ id, text: id })), snap)
    const out = await Effect.runPromise(e.query({ type: "notes/topic", where: { tier: "free" }, limit: 1 }))
    expect(out.map((x) => x.id)).toEqual(["T-0001"])
    expect(calls).toEqual(["label:T-0001"])
  })
})
describe("versions", () => {
  test("an owner that serves versions and has none for an id: the entity is gone, never versioned another way", async () => {
    const { e } = backend(kind(), (p) => (p.op === "version" ? [] : serve(p)))
    const err = await Effect.runPromise(Effect.flip(e.get("board/item:B-1")))
    expect(err.tag).toBe("NotFound")
  })
})
