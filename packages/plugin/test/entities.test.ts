import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { bundle, fixturePlugin, hostWith } from "./fixtures"

// The notes fixture plus a tool that removes a topic.
const NOTES_SOURCE = readFileSync(join(import.meta.dir, "fixtures/notes/index.ts"), "utf8")
  .replace('import { diff, Put, Snapshot } from "@zarg/graph/pure"', 'import { diff, Put, Remove, Snapshot } from "@zarg/graph/pure"')
  .replace('"add-note": { doc:', '"remove-topic": { doc: "Remove a topic", params: Schema.Struct({ id: Schema.String }), success: ToolResult, agents: true },\n    "add-note": { doc:')
  .replace('"add-note": ({ text, topic }) =>', '"remove-topic": ({ id }) => Effect.succeed({ changes: [Remove(id)], message: `removed ${id}` }),\n      "add-note": ({ text, topic }) =>')

const board = (name = "board", extra = "") => `
import { Effect, Schema } from "effect"
import { definePlugin, PluginFailure } from "@zarg/plugin-sdk"
const Item = Schema.Struct({ title: Schema.String })
const items = { "B-1": { title: "First" }, "B-2": { title: "Second" } }
export default definePlugin({
  name: "${name}", service: "${name[0]!.toUpperCase() + name.slice(1)}", archetype: "service", config: Schema.Struct({}), scopes: { ${extra} },
  entities: { item: { doc: "Items.", data: Item, tone: "accent", glyph: "▦", commands: { rename: "rename" }, ops: ["get", "label", "version", "query"] } },
  methods: { rename: { doc: "Rename.", params: Schema.Struct({ id: Schema.String, title: Schema.String }), success: Schema.String } },
  make: Effect.succeed({
    rename: ({ id, title }) => Effect.succeed(id + "=" + title),
    entities: { item: {
      get: (ids) => ids.includes("B-boom") ? Effect.fail(new PluginFailure({ tag: "Boom", message: "provider broke" })) : Effect.succeed(ids.flatMap((id) => (items[id] ? [{ id, data: items[id] }] : []))),
      query: ({ text }) => Effect.succeed(Object.keys(items).filter((id) => text === undefined || items[id].title.toLowerCase().includes(text))),
      label: (e) => e.data.title,
    } },
  }),
})`

describe("the host's entities", () => {
  test("a ref reaches its owner: get, label, version, query and a routed command", async () => {
    const p = await fixturePlugin(board())
    const out = await Effect.runPromise(hostWith([p], (h) => Effect.gen(function* () {
      const e = yield* h.entities.get("board/item:B-1")
      const q = yield* h.entities.query({ type: "board/item", text: "second" })
      const cmd = yield* h.entities.command("board/item:B-1", "rename", { title: "One" })
      return { e, q: q.map((x) => x.id), cmd }
    })))
    expect(out.e).toMatchObject({ type: "board/item", id: "B-1", data: { title: "First" }, label: { text: "First", tone: "accent", glyph: "▦" } })
    expect(out.e.ref).toBe(`board/item:B-1@${out.e.version}`)
    expect(out.q[0]).toBe("B-2")
    expect(out.cmd).toBe("B-1=One")
  })
  test("one failing provider does not fail the others", async () => {
    const [a, b] = await Promise.all([fixturePlugin(board()), fixturePlugin(board("other"))])
    const out = await Effect.runPromise(hostWith([a!, b!], (h) => h.entities.many(["board/item:B-1", "other/item:B-boom", "nope/kind:X"])))
    expect(out.entities.map((e) => e.id)).toEqual(["B-1"])
    expect(out.failed.map((f) => [f.ref, f._tag])).toEqual([["other/item:B-boom", "ProviderFailed"], ["nope/kind:X", "UnknownType"]])
  })
  test("unparsable refs are refused with the reason, never routed", async () => {
    const p = await fixturePlugin(board())
    const err = await Effect.runPromise(hostWith([p], (h) => Effect.flip(h.entities.get("C-0062"))))
    expect(err.tag).toBe("NotFound")
    expect(err.message).toMatch(/no type/)
  })
  test("a duplicate type is refused at load", async () => {
    const a = await fixturePlugin(board())
    const twin = { ...a, manifest: { ...a.manifest } }
    const out = await Effect.runPromise(hostWith([a, twin], (h) => Effect.map(h.agenda(), (items) => items.map((i) => `${i.title} ${i.detail}`))))
    expect(out.some((t) => /board.*failed to load/.test(t) || /already/.test(t))).toBe(true)
  })
  test("graph kinds are served without a provider; a removed node: version null, changed true", async () => {
    const out = await Effect.runPromise(hostWith([await fixturePlugin(NOTES_SOURCE)], (h) => Effect.gen(function* () {
      yield* h.call("notes/add-topic", { name: "pricing" })
      const e = yield* h.entities.get("notes/topic:T-0001")
      yield* h.call("notes/remove-topic", { id: "T-0001" })
      return { e, v: yield* h.entities.version(`notes/topic:T-0001`), changed: yield* h.entities.changed(e.ref) }
    })))
    expect(out.e).toMatchObject({ type: "notes/topic", id: "T-0001", label: { text: "pricing" } })
    expect(out.v).toBeNull()
    expect(out.changed).toBe(true)
  })
  test("a plugin reads only the types its scope names, and its own", async () => {
    const reader = `
import { Effect, Schema } from "effect"
import { definePlugin, Entities } from "@zarg/plugin-sdk"
export default definePlugin({
  name: "reader", service: "Reader", archetype: "service", config: Schema.Struct({}), scopes: { entities: { read: ["board/*"] } },
  methods: { read: { doc: "Read.", params: Schema.Struct({ ref: Schema.String }), success: Schema.String } },
  make: Effect.gen(function* () { const e = yield* Entities; return { read: ({ ref }) => Effect.map(e.get(ref), (x) => x.label.text).pipe(Effect.catch((f) => Effect.succeed(f.tag))) } }),
})`
    const [a, b, r] = await Promise.all([fixturePlugin(board()), fixturePlugin(board("other")), fixturePlugin(reader)])
    const out = await Effect.runPromise(hostWith([a!, b!, r!], (h) => Effect.all([h.invoke("reader", "read", { ref: "board/item:B-1" }), h.invoke("reader", "read", { ref: "other/item:B-1" })]), { yolo: { on: () => true } }))
    expect(out).toEqual(["First", "NotAllowed"])
  })
  test("graph kinds' data is typed as served: { props, edges }", async () => {
    const out = await Effect.runPromise(hostWith([await fixturePlugin(NOTES_SOURCE)], (h) => Effect.succeed(h.entities.types().find((t) => t.type === "notes/topic")!.data)))
    const schema = (out as { schema: { properties: Record<string, { properties?: Record<string, unknown> }> } }).schema
    expect(Object.keys(schema.properties)).toEqual(["props", "edges"])
    expect(Object.keys(schema.properties.props!.properties!)).toEqual(["name"])
  })
  test("a command to a graph plugin's tool goes through its write pipeline (it commits)", async () => {
    const src = NOTES_SOURCE.replace('graph: { nodes:', 'entities: { topic: { doc: "Topics.", data: Schema.Struct({ name: Schema.String }), tone: "accent", glyph: "#", commands: { note: "add-note" } } },\n  graph: { nodes:')
    const out = await Effect.runPromise(hostWith([await fixturePlugin(src)], (h) => Effect.gen(function* () {
      yield* h.call("notes/add-topic", { name: "pricing" })
      yield* h.entities.command("notes/topic:T-0001", "note", { text: "cheap", topic: "T-0001" })
      return yield* h.entities.get("notes/note:N-0001")
    })))
    expect(out.label.text).toBe("cheap")
  })
  test("an owner that answers with the wrong shape fails only its own refs", async () => {
    const good = await fixturePlugin(board())
    const other = await fixturePlugin(board("other"))
    const bad = { ...other, bundle: bundle(`{ $start: async () => null, $entity: async () => ({}) }`).replace("module.exports.default = {", 'module.exports.default = { name: "other", service: "Other", archetype: "service",') }
    const out = await Effect.runPromise(hostWith([good, bad], (h) => h.entities.many(["board/item:B-1", "other/item:B-1"])))
    expect(out.entities.map((e) => e.ref.split("@")[0])).toEqual(["board/item:B-1"])
    expect(out.failed.map((f) => [f.ref, f._tag])).toEqual([["other/item:B-1", "ProviderFailed"]])
  })
  test("a plugin method's own failure tag stays PluginError for its callers (entity tags are for the entities power)", async () => {
    const p = await fixturePlugin(board().replace('rename: ({ id, title }) => Effect.succeed(id + "=" + title),', 'rename: () => Effect.fail(new PluginFailure({ tag: "NotFound", message: "gone" })),'))
    const err = await Effect.runPromise(hostWith([p], (h) => Effect.flip(h.invoke("board", "rename", { id: "B-1", title: "x" }))))
    expect(err._tag).toBe("PluginError")
  })
})
