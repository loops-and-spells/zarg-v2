import { BunServices } from "@effect/platform-bun"
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, FileSystem, Layer } from "effect"
import { GraphStore, hash, layer as graphLayer } from "@zarg/graph"
import { buildPlugin } from "@zarg/plugin-sdk/tools"
import { makeGrants } from "../src/runtime"
import { type HostOptions, isFirstParty, layer as hostLayer, type LoadedPlugin, PluginHost } from "../src/server"

let notes: LoadedPlugin
beforeAll(async () => {
  const r = await buildPlugin(join(import.meta.dir, "fixtures/notes/index.ts"))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  notes = { manifest: r.manifest as never, bundle: r.bundle, origin: join(import.meta.dir, "fixtures/notes") }
})

const options = (extra: Partial<HostOptions> = {}): HostOptions => ({
  grants: Effect.runSync(makeGrants({ file: join(mkdtempSync(join(tmpdir(), "zt-host-")), "grants.json"), project: "/zt/project" })),
  vault: () => Effect.succeed(undefined),
  config: () => ({}),
  ask: () => Effect.succeed("deny"),
  yolo: { on: () => false },
  log: () => {},
  redact: (t) => t,
  firstParty: () => true,
  ...extra,
})

const runWith = <A, E>(plugins: () => ReadonlyArray<LoadedPlugin>, opts: () => HostOptions, body: Effect.Effect<A, E, PluginHost | GraphStore | FileSystem.FileSystem>) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    const graph = graphLayer(dir)
    return yield* body.pipe(Effect.provide(Layer.provideMerge(hostLayer(plugins(), opts()), graph)))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

const run = <A, E>(body: Effect.Effect<A, E, PluginHost | GraphStore | FileSystem.FileSystem>) => runWith(() => [notes], () => options(), body)

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

  test("concurrent calls in one process each commit, with distinct ids", async () => {
    const out = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        const rs = yield* Effect.all(
          ["a", "b", "c", "d"].map((name) => host.call("notes/add-topic", { name })),
          { concurrency: "unbounded" },
        )
        const snap = yield* (yield* GraphStore).snapshot
        return { added: rs.flatMap((r) => r.added), ids: [...snap.nodes.keys()].sort() }
      }),
    )
    expect(out.added.sort()).toEqual(["T-0001", "T-0002", "T-0003", "T-0004"])
    expect(out.ids).toEqual(["T-0001", "T-0002", "T-0003", "T-0004"])
  })

  test("exclusive holds tool calls until it finishes (landing uses it)", async () => {
    const order = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        const log: Array<string> = []
        const fiber = yield* Effect.forkChild(host.exclusive(Effect.andThen(Effect.sleep(100), Effect.sync(() => log.push("exclusive done")))))
        yield* Effect.sleep(10)
        yield* host.call("notes/add-topic", { name: "x" })
        log.push("call done")
        yield* Fiber.join(fiber)
        return log
      }),
    )
    expect(order).toEqual(["exclusive done", "call done"])
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

describe("plugins in their processes", () => {
  test("invalid props come back as LintFailed from the plugin's validate", async () => {
    const err = await run(Effect.gen(function* () {
      yield* (yield* GraphStore).commit([{ _tag: "Put", node: { id: "T-0001", type: "notes/topic", props: { name: "a" }, edges: [] } }])
      return yield* Effect.flip(PluginHost.use((h) => h.call("notes/add-note", { text: 3 as never, topic: "T-0001" })))
    }))
    expect(err._tag).toBe("ToolError")
    const codes = await run(Effect.gen(function* () {
      yield* (yield* GraphStore).commit([{ _tag: "Put", node: { id: "T-0001", type: "notes/topic", props: { name: 3 }, edges: [] } }])
      return (yield* (yield* PluginHost).lint).map((f) => f.code)
    }))
    expect(codes).toEqual(["invalid-props"])
  })

  test("an ungranted plugin with a net scope does not load and puts its request on the agenda", async () => {
    const netty = () => [{ ...notes, manifest: { ...notes.manifest, scopes: { graph: "read", net: ["a.test"] } } as never }]
    const out = await runWith(netty, () => options({ firstParty: () => false }), PluginHost.use((h) => Effect.all([h.agenda(), Effect.succeed(h.tools)])))
    expect(out[0].map((i) => i.title)).toEqual(["Plugin notes asks for: read your graph, reach a.test"])
    expect(out[0][0]!.detail).toContain("can read your graph and send it to a.test")
    expect(out[1]).toEqual([])
  })
  test("a first-party plugin with only graph scope is granted without a question", async () => {
    const asked: Array<unknown> = []
    const r = await runWith(() => [notes], () => options({ firstParty: () => true, ask: (q) => Effect.sync(() => (asked.push(q), "deny" as const)) }), PluginHost.use((h) => h.call("notes/add-topic", { name: "a" })))
    expect(r.added).toEqual(["T-0001"])
    expect(asked).toEqual([])
  })
  test("a plugin named like a first-party one elsewhere is not first-party", () => {
    const root = "/opt/zarg"
    expect(isFirstParty({ ...notes, origin: "/home/x/plugins/gherkin" }, root, new Set(["whatever"]))).toBe(false)
    expect(isFirstParty({ ...notes, origin: `${root}/packages/plugin-gherkin/dist` }, root, new Set(["not-its-hash"]))).toBe(false)
  })
  test("a plugin that throws while loading is reported and others still load", async () => {
    const broken: LoadedPlugin = { manifest: { ...notes.manifest, name: "broken", service: "Broken" } as never, bundle: "throw new Error('broken at load')", origin: "/zt" }
    const out = await runWith(() => [broken, notes], () => options(), PluginHost.use((h) => Effect.all([h.agenda(), h.call("notes/add-topic", { name: "x" })])))
    expect(out[0].map((i) => i.id)).toContain("plugin-failed:broken")
    expect(out[1].added).toEqual(["T-0001"])
  })
  test("a restarted plugin gets the full snapshot again", async () => {
    const text = await run(Effect.gen(function* () {
      const h = yield* PluginHost
      yield* h.call("notes/add-topic", { name: "one" })
      yield* h.call("notes/add-topic", { name: "two" })
      yield* Effect.flip(h.call("notes/spin", {}))
      return yield* h.render()
    }))
    expect(text).toBe("# one\n# two")
  })
  test("affected unions the graph plugins' answers", async () => {
    const r = await run(Effect.gen(function* () {
      const h = yield* PluginHost
      const store = yield* GraphStore
      yield* h.call("notes/add-topic", { name: "a" })
      const before = yield* store.snapshot
      yield* h.call("notes/add-note", { text: "x", topic: "T-0001" })
      return yield* h.affected(before, yield* store.snapshot)
    }))
    expect(r).toEqual({ cards: ["N-0001"], removed: [] })
  })
  test("a plugin process stops after idleMs and starts again on the next call", async () => {
    const r = await runWith(() => [notes], () => options({ idleMs: 150 }), Effect.gen(function* () {
      const h = yield* PluginHost
      yield* h.call("notes/add-topic", { name: "a" })
      yield* Effect.sleep(400)
      return yield* h.call("notes/add-topic", { name: "b" })
    }))
    expect(r.added).toEqual(["T-0002"])
  })
  test("three restarts in ten minutes disable a plugin", async () => {
    const out = await run(Effect.gen(function* () {
      const h = yield* PluginHost
      for (let i = 0; i < 3; i++) yield* Effect.flip(h.call("notes/spin", {}))
      const after = yield* Effect.flip(h.call("notes/add-topic", { name: "x" }))
      return { after: after.message, agenda: (yield* h.agenda()).map((i) => i.id) }
    }))
    expect(out.after).toContain("disabled")
    expect(out.agenda).toContain("plugin-disabled:notes")
  })
})
