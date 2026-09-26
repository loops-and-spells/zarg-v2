import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { GraphStore, hash, layer as graphLayer } from "@zarg/graph"
import { layer as hostLayer, PluginHost } from "../src/server"
import { notes } from "./fixture-plugin"

const run = <A, E>(body: Effect.Effect<A, E, PluginHost | GraphStore | FileSystem.FileSystem>) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    const graph = graphLayer(dir)
    return yield* body.pipe(Effect.provide(Layer.provideMerge(hostLayer([notes]), graph)))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

describe("PluginHost.call", () => {
  test("runs a tool and commits its changes", async () => {
    const out = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        const r = yield* host.call("notes/add-topic", { name: "pricing" })
        const snap = yield* (yield* GraphStore).snapshot
        return { r, ids: [...snap.nodes.keys()] }
      }),
    )
    expect(out.r).toEqual({ message: "created T-0001", added: ["T-0001"], changed: [], removed: [], warnings: [] })
    expect(out.ids).toEqual(["T-0001"])
  })

  test("unknown tool and invalid params are ToolErrors", async () => {
    const errs = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        const a = yield* Effect.flip(host.call("notes/nope", {}))
        const b = yield* Effect.flip(host.call("notes/add-topic", { name: 1 }))
        return [a, b]
      }),
    )
    expect(errs.map((e) => e._tag)).toEqual(["ToolError", "ToolError"])
    expect(errs[0]?._tag === "ToolError" && errs[0].message).toContain("zarg tool list")
  })

  test("an error finding blocks the commit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        const err = yield* Effect.flip(host.call("notes/add-topic", { name: "" }))
        const size = (yield* (yield* GraphStore).snapshot).nodes.size
        return { err, size }
      }),
    )
    expect(out.err._tag).toBe("LintFailed")
    expect(out.size).toBe(0)
  })

  test("warnings are returned and do not block", async () => {
    const r = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        yield* host.call("notes/add-topic", { name: "a" })
        return yield* host.call("notes/add-note", { text: "TODO later", topic: "T-0001" })
      }),
    )
    expect(r.added).toEqual(["N-0001"])
    expect(r.warnings.map((w) => w.code)).toEqual(["todo"])
  })

  test("a caller expectation that no longer holds fails with StaleNode", async () => {
    const err = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        yield* host.call("notes/add-topic", { name: "a" })
        const t = (yield* (yield* GraphStore).snapshot).nodes.get("T-0001")!
        const seen = hash(t)
        yield* (yield* GraphStore).commit([{ _tag: "Put", node: { ...t, props: { name: "b" } } }])
        return yield* Effect.flip(host.call("notes/add-note", { text: "x", topic: "T-0001" }, { "T-0001": seen }))
      }),
    )
    expect(err._tag).toBe("StaleNode")
  })
})

describe("PluginHost read side", () => {
  // @card UX-0001
  test("agenda lists plugin items and bad files, filtered by focus", async () => {
    const out = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        yield* host.call("notes/add-topic", { name: "a" })
        yield* host.call("notes/add-topic", { name: "b" })
        const all = yield* host.agenda()
        const focused = yield* host.agenda(new Set(["T-0002"]))
        return { all: all.map((i) => i.id), focused: focused.map((i) => i.id) }
      }),
    )
    expect(out.all).toEqual(["empty:T-0001", "empty:T-0002"])
    expect(out.focused).toEqual(["empty:T-0002"])
  })

  test("render joins plugin views", async () => {
    const text = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        yield* host.call("notes/add-topic", { name: "pricing" })
        return yield* host.render()
      }),
    )
    expect(text).toBe("# pricing")
  })

  test("lint checks the whole graph", async () => {
    const codes = await run(
      Effect.gen(function* () {
        yield* (yield* GraphStore).commit([
          { _tag: "Put", node: { id: "N-0001", type: "notes/note", props: { text: "x" }, edges: [] } },
        ])
        return (yield* (yield* PluginHost).lint).map((f) => f.code)
      }),
    )
    expect(codes).toEqual(["too-few-edges"])
  })

  test("tools lists names with JSON schema params", async () => {
    const tools = await run(PluginHost.use((h) => Effect.succeed(h.tools)))
    expect(tools.map((t) => t.name)).toEqual(["notes/add-topic", "notes/add-note"])
    expect(JSON.stringify(tools[0]?.params)).toContain('"name"')
  })
})
