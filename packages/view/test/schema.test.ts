import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DATA, LayoutSchema } from "../src"

describe("section data", () => {
  test("each kind's data round trips and rejects the wrong shape", () => {
    const ok = {
      stats: { items: [{ label: "steps", value: "14/22" }], progress: { done: 14, total: 22 } },
      list: { items: [{ id: "s3", text: "story 3", state: "busy" }] },
      log: { lines: [{ text: "UX-1 ok", tone: "dim" }] },
      table: { rows: [{ id: "R-1", cells: { id: "R-1", note: "unclear" } }] },
      keyvalue: { pairs: [{ key: "card", value: "UX-1" }] },
      text: { markdown: "**done**" },
    } as const
    for (const [kind, data] of Object.entries(ok)) {
      const s = DATA[kind as keyof typeof DATA]
      expect(Schema.decodeUnknownSync(s as Schema.Codec<unknown, unknown>)(data)).toEqual(data)
    }
    expect(() => Schema.decodeUnknownSync(DATA.table as Schema.Codec<unknown, unknown>)({ rows: [{ id: "x", cells: { a: 1 } }] })).toThrow()
    expect(() => Schema.decodeUnknownSync(DATA.log as Schema.Codec<unknown, unknown>)({ lines: [{ text: "x", tone: "red" }] })).toThrow()
  })

  test("a layout is plain data: kinds, roles, columns and actions, nothing about looks", () => {
    const layout = {
      name: "tester",
      sections: [
        { id: "progress", kind: "stats", role: "summary" },
        { id: "review", kind: "tabs", role: "pinned", tabs: [{ id: "findings", kind: "table", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] }] },
      ],
    }
    expect(Schema.decodeUnknownSync(LayoutSchema)(layout)).toEqual(layout as never)
    expect(() => Schema.decodeUnknownSync(LayoutSchema)({ name: "x", sections: [{ id: "a", kind: "stats", role: "left" }] })).toThrow()
  })
})
