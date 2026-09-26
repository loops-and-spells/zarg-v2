import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { diff, type Node, Snapshot } from "@zarg/graph"
import { check, PluginConfigError, registry, server } from "../src/server"
import { notes } from "./fixture-plugin"

const reg = registry([notes])
const topic: Node = { id: "T-0001", type: "notes/topic", props: { name: "x" }, edges: [] }
const findings = (nodes: ReadonlyArray<Node>) => {
  const after = Snapshot.make(nodes)
  return check(reg, { before: Snapshot.empty, after, diff: diff(Snapshot.empty, after) }).map((f) => f.code)
}

describe("registry", () => {
  test("rejects a duplicate plugin name", () => {
    expect(() => registry([notes, notes])).toThrow(PluginConfigError)
  })
  test("rejects a missing required plugin", () => {
    expect(() => registry([server({ name: "x", requires: ["y"] })])).toThrow('requires "y"')
  })
  test("rejects an edge between unknown node types", () => {
    const bad = server({ name: "x", nodes: { a: Schema.Struct({}) }, edges: { e: { from: "a", to: "b" } } })
    expect(() => registry([bad])).toThrow('unknown node type "x/b"')
  })
})

describe("check", () => {
  test("a valid graph has no findings", () => {
    expect(findings([topic, { id: "N-0001", type: "notes/note", props: { text: "hi" }, edges: [{ type: "notes/about", to: "T-0001" }] }])).toEqual([])
  })
  test("unknown node type", () => {
    expect(findings([{ id: "X-1", type: "nope/x", props: {}, edges: [] }])).toEqual(["unknown-type"])
  })
  test("props that fail the schema", () => {
    expect(findings([{ ...topic, props: { name: 3 } }])).toEqual(["invalid-props"])
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
  // @card UX-0007
  test("the same edge twice is refused with a fix hint", () => {
    const note: Node = {
      id: "N-0001",
      type: "notes/note",
      props: { text: "a" },
      edges: [{ type: "notes/about", to: "T-0001" }, { type: "notes/about", to: "T-0001" }],
    }
    const after = Snapshot.make([topic, note])
    const found = check(reg, { before: Snapshot.empty, after, diff: diff(Snapshot.empty, after) })
    expect(found.map((f) => f.code)).toContain("duplicate-edge")
    expect(found.find((f) => f.code === "duplicate-edge")?.message).toBe(
      'N-0001: links T-0001 as "notes/about" twice; remove the duplicate',
    )
  })

  test("plugin lints run after structural checks", () => {
    expect(findings([{ ...topic, props: { name: "" } }])).toEqual(["empty-name"])
  })
})
