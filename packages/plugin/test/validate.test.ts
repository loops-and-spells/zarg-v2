import { describe, expect, test } from "bun:test"
import { diff, type Node, Snapshot } from "@zarg/graph"
import { checkStructure, manifestRegistry, PluginConfigError } from "../src/server"

// The notes plugin's graph, as its manifest declares it (props are the plugin's own check).
const notes = { name: "notes", graph: { nodes: { topic: {}, note: {} }, edges: { about: { from: "note", to: "topic", min: 1, max: 1 } } } }
const reg = manifestRegistry([notes])
const topic: Node = { id: "T-0001", type: "notes/topic", props: { name: "x" }, edges: [] }
const check = (nodes: ReadonlyArray<Node>) => {
  const after = Snapshot.make(nodes)
  return checkStructure(reg, { before: Snapshot.empty, after, diff: diff(Snapshot.empty, after) })
}
const findings = (nodes: ReadonlyArray<Node>) => check(nodes).map((f) => f.code)

describe("manifest registry", () => {
  test("rejects a duplicate plugin name", () => {
    expect(() => manifestRegistry([notes, notes])).toThrow(PluginConfigError)
  })
  test("rejects an edge between unknown node types", () => {
    expect(() => manifestRegistry([{ name: "x", graph: { nodes: { a: {} }, edges: { e: { from: "a", to: "b" } } } }])).toThrow('unknown node type "x/b"')
  })
})

describe("structure", () => {
  test("a valid graph has no findings", () => {
    expect(findings([topic, { id: "N-0001", type: "notes/note", props: { text: "hi" }, edges: [{ type: "notes/about", to: "T-0001" }] }])).toEqual([])
  })
  test("unknown node type", () => {
    expect(findings([{ id: "X-1", type: "nope/x", props: {}, edges: [] }])).toEqual(["unknown-type"])
  })
  test("too few and too many edges", () => {
    expect(findings([topic, { id: "N-0001", type: "notes/note", props: { text: "hi" }, edges: [] }])).toEqual(["too-few-edges"])
    const two = [{ type: "notes/about", to: "T-0001" }, { type: "notes/about", to: "T-0002" }]
    expect(findings([topic, { ...topic, id: "T-0002" }, { id: "N-0001", type: "notes/note", props: { text: "hi" }, edges: two }])).toEqual(["too-many-edges"])
  })
  test("edge pointing at the wrong node type", () => {
    const n1: Node = { id: "N-0001", type: "notes/note", props: { text: "a" }, edges: [{ type: "notes/about", to: "T-0001" }] }
    const n2: Node = { id: "N-0002", type: "notes/note", props: { text: "b" }, edges: [{ type: "notes/about", to: "N-0001" }] }
    expect(findings([topic, n1, n2])).toEqual(["edge-target"])
  })
  // @scenario S-0007
  test("the same edge twice is refused with a fix hint", () => {
    const note: Node = { id: "N-0001", type: "notes/note", props: { text: "a" }, edges: [{ type: "notes/about", to: "T-0001" }, { type: "notes/about", to: "T-0001" }] }
    const found = check([topic, note])
    expect(found.map((f) => f.code)).toContain("duplicate-edge")
    expect(found.find((f) => f.code === "duplicate-edge")?.message).toBe('N-0001: links T-0001 as "notes/about" twice; remove the duplicate')
  })
})

describe("an edge to several node types", () => {
  const tags = { name: "tags", graph: { nodes: { tag: {}, note: {}, topic: {}, other: {} }, edges: { on: { from: "tag", to: ["note", "topic"] } } } }
  const reg2 = manifestRegistry([tags])
  const check2 = (nodes: ReadonlyArray<Node>) => {
    const after = Snapshot.make(nodes)
    return checkStructure(reg2, { before: Snapshot.empty, after, diff: diff(Snapshot.empty, after) })
  }
  const node = (id: string, type: string, edges: Node["edges"] = []): Node => ({ id, type: `tags/${type}`, props: {}, edges })
  test("it may point at any of them", () => {
    expect(check2([node("N-1", "note"), node("T-1", "topic"), node("G-1", "tag", [{ type: "tags/on", to: "N-1" }, { type: "tags/on", to: "T-1" }])])).toEqual([])
  })
  test("any other type is a wrong target, naming every allowed one", () => {
    const found = check2([node("X-1", "other"), node("G-1", "tag", [{ type: "tags/on", to: "X-1" }])])
    expect(found.map((f) => f.code)).toEqual(["edge-target"])
    expect(found[0]!.message).toBe('G-1: "tags/on" must point to a tags/note or tags/topic, X-1 is a tags/other')
  })
  test("an unknown type in the list is refused at registration", () => {
    expect(() => manifestRegistry([{ name: "x", graph: { nodes: { a: {} }, edges: { e: { from: "a", to: ["a", "b"] } } } }])).toThrow('unknown node type "x/b"')
  })
})
