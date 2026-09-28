import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { definePlugin } from "../src"
import { manifestOf } from "../src/manifest"

const Item = Schema.Struct({ title: Schema.String, lane: Schema.String })
const items = new Map([["B-1", { title: "First", lane: "ready" }]])
const plugin = (tone = "accent") =>
  definePlugin({
    name: "board", service: "Board", archetype: "service", config: Schema.Struct({}), scopes: {},
    entities: { item: { doc: "A board item.", data: Item, tone: tone as never, glyph: "▦", commands: { move: "move-item" }, open: "board" } },
    methods: { "move-item": { doc: "Move an item.", params: Schema.Struct({ id: Schema.String, to: Schema.String }), success: Schema.Null } },
    make: Effect.succeed({
      "move-item": () => Effect.succeed(null),
      entities: { item: { get: (ids: ReadonlyArray<string>) => Effect.succeed(ids.flatMap((id) => (items.has(id) ? [{ id, data: items.get(id)! }] : []))), label: (e: { data: typeof Item.Type }) => e.data.title } },
    }),
  })

describe("entity kinds", () => {
  test("travel in the manifest with their data schema, tone, glyph, commands and the ops the plugin serves", () => {
    const m = manifestOf(plugin()).entities!.item!
    expect([m.tone, m.glyph, m.commands, m.open, m.ops]).toEqual(["accent", "▦", { move: "move-item" }, "board", ["get", "label", "version"]])
    expect(JSON.stringify(m.data)).toContain("title")
  })
  test("a tone plugins may not name is refused at build", () => {
    expect(() => plugin("ground")).toThrow(/item.*ground.*may name/)
  })
  test("a command naming no method is refused at build", () => {
    expect(() => definePlugin({ ...plugin(), entities: { item: { doc: "x", data: Item, tone: "accent", glyph: "▦", commands: { move: "nope" } } } })).toThrow(/command move calls nope/)
  })
  test("$entity serves get, label and a default version over the handlers", async () => {
    const serve = plugin().serve({ call: async () => null } as never)
    expect(await serve.$entity!({ op: "get", kind: "item", ids: ["B-1", "B-9"] })).toEqual([{ id: "B-1", data: { title: "First", lane: "ready" } }])
    expect(await serve.$entity!({ op: "label", kind: "item", ids: ["B-1"] })).toEqual([{ id: "B-1", text: "First" }])
    const [v] = (await serve.$entity!({ op: "version", kind: "item", ids: ["B-1"] })) as Array<{ version: string }>
    expect(v!.version).toMatch(/^[0-9a-f]{12}$/)
  })
  test("an op declared without its handler is refused when the plugin starts, naming both", async () => {
    const p = definePlugin({ ...plugin(), entities: { item: { doc: "x", data: Item, tone: "accent", glyph: "▦", ops: ["get", "query"] } } })
    await expect(p.serve({ call: async () => null } as never).$start!(undefined)).rejects.toThrow(/entity item declares query but has no query handler/)
  })
})
