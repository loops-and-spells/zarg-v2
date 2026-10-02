import { BunServices } from "@effect/platform-bun"
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, FileSystem, Layer, Redacted } from "effect"
import { GraphStore, hash, layer as graphLayer } from "@zarg/graph"
import { buildPlugin } from "@zarg/plugin-sdk/tools"
import { makeGrants, scopesDigest } from "../src/runtime"
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

  // @card S-0016
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
  // @card S-0001
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
    expect(out.all).toEqual(["notes:empty:T-0001", "notes:empty:T-0002"])
    expect(out.focused).toEqual(["notes:empty:T-0002"])
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
  // @card S-0069
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
  // @card S-0068
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
  test("a plugin that ends by itself (a deadline, a crash) is reported stopped: the core moots what it waited on", async () => {
    const stopped: Array<string> = []
    await runWith(() => [notes], () => ({ ...options(), stopped: (p: string) => void stopped.push(p) }), Effect.gen(function* () {
      yield* Effect.flip((yield* PluginHost).call("notes/spin", {}))
    }))
    expect(stopped).toContain("notes")
  })
})

describe("review fixes: the host", () => {
  const raw = (manifest: Record<string, unknown>, methods: string): LoadedPlugin => ({
    manifest: { config: {}, scopes: {}, optional: {}, archetype: "graph", ...manifest, methods: manifest.methods ?? {} } as never,
    bundle: `module.exports.default = { name: ${JSON.stringify(manifest.name)}, service: ${JSON.stringify(manifest.service)}, archetype: ${JSON.stringify(manifest.archetype ?? "graph")}, serve: (powers) => (${methods}) }`,
    origin: "/zt/raw",
  })
  const m = (doc = "x", agents = true) => ({ doc, params: {}, success: {}, agents, stream: false })
  const approved = (plugins: ReadonlyArray<LoadedPlugin>, extra: Partial<HostOptions> = {}) => () => {
    const o = options({ firstParty: () => false, ...extra })
    for (const p of plugins) Effect.runSync(o.grants.approveLoad(p.manifest.name, scopesDigest(p.manifest.scopes, p.manifest.optional)))
    return o
  }

  test("a secret the plugin was served never comes back out of it, in results or errors", async () => {
    const leaky = raw({ name: "zt-leak", service: "ZtLeak", scopes: { graph: "write", secrets: ["TOKEN"] }, methods: { leak: m(), boom: m() } }, `{
      leak: async () => ({ changes: [], message: "token " + await powers.call("secrets.get", { name: "TOKEN" }) }),
      boom: async () => { throw new Error("failed with " + await powers.call("secrets.get", { name: "TOKEN" })) },
    }`)
    const vault = (name: string) => Effect.succeed(name === "ZARG_PLUGIN_ZT_LEAK__TOKEN" ? Redacted.make("zt-leaky-secret") : undefined)
    const out = await runWith(() => [leaky], approved([leaky], { vault }), Effect.gen(function* () {
      const h = yield* PluginHost
      const ok = yield* h.call("zt-leak/leak", {})
      const err = yield* Effect.flip(h.call("zt-leak/boom", {}))
      return JSON.stringify([ok, err.message])
    }))
    expect(out).not.toContain("zt-leaky-secret")
    expect(out).toContain("<redacted:plugin-secret>")
  })

  test("a plugin without graph write cannot change the graph, and one without graph scope is never shown it", async () => {
    const reader = raw({ name: "zt-reader", service: "ZtReader", scopes: { graph: "read" }, methods: { write: m() } }, `{ write: async () => ({ changes: [{ _tag: "Put", node: { id: "N-9", type: "notes/note", props: { text: "x" }, edges: [] } }], message: "wrote" }) }`)
    const blind = raw({ name: "zt-blind", service: "ZtBlind", scopes: {}, methods: { agenda: m("agenda", false) } }, `{ agenda: async () => [{ id: "saw-it", title: "saw the graph", detail: "", about: [], priority: 1 }] }`)
    const out = await runWith(() => [reader, blind], approved([reader, blind]), Effect.gen(function* () {
      const h = yield* PluginHost
      const e = yield* Effect.flip(h.call("zt-reader/write", {}))
      return { e: e.message, agenda: (yield* h.agenda()).map((i) => i.id) }
    }))
    expect(out.e).toContain("may not change the graph")
    expect(out.agenda).not.toContain("saw-it")
  })

  test("a write whose checks cannot run is refused, not let through", async () => {
    const broken = raw({ name: "zt-broken", service: "ZtBroken", scopes: { graph: "write" }, methods: { add: m(), lint: m("lint", false) } }, `{
      add: async () => ({ changes: [], message: "nothing" }),
      lint: async () => { throw new Error("lint broke") },
    }`)
    const e = await runWith(() => [broken], approved([broken]), Effect.flip(PluginHost.use((h) => h.call("zt-broken/add", {}))))
    expect(e._tag).toBe("LintFailed")
    expect(JSON.stringify(e)).toContain("could not check")
  })

  test("the approval request names the optional scopes too", async () => {
    const asker = raw({ name: "zt-asker", service: "ZtAsker", archetype: "provider", scopes: {}, optional: { net: "ask", fs: { read: "ask" } } }, `{}`)
    const items = await runWith(() => [asker], () => options({ firstParty: () => false }), PluginHost.use((h) => h.agenda()))
    expect(items[0]!.title).toBe("Plugin zt-asker asks for: nothing now; may ask to reach hosts it asks for, read files it asks for")
  })

  test("a manifest that does not match its bundle, a reserved service or a bad method name does not load", async () => {
    const liar = { ...raw({ name: "zt-liar", service: "ZtLiar", scopes: {} }, `{}`), bundle: `module.exports.default = { name: "gherkin", service: "Gherkin", archetype: "graph", serve: () => ({}) }` }
    const hijack = raw({ name: "zt-hijack", service: "Inquire", scopes: {} }, `{}`)
    const badMethod = raw({ name: "zt-bad", service: "ZtBad", scopes: {}, methods: { "Bad Name": m() } }, `{}`)
    const badDoc = raw({ name: "zt-doc", service: "ZtDoc", scopes: {}, methods: { ok: m("ends */ here") } }, `{}`)
    const plugins = [liar, hijack, badMethod, badDoc]
    const out = await runWith(() => plugins, approved(plugins), PluginHost.use((h) => Effect.all([h.agenda(), Effect.succeed(h.manifests.map((x) => x.name))])))
    expect(out[0].filter((i) => i.id.startsWith("plugin-failed:")).map((i) => i.id).sort()).toEqual(["plugin-failed:zt-bad", "plugin-failed:zt-hijack", "plugin-failed:zt-liar"])
    expect(out[1]).toEqual(["zt-doc"])
    expect(out[1].length).toBe(1)
  })

  test("a call's deadline stops while its grant question waits on the developer", async () => {
    const asker = raw({ name: "zt-slowask", service: "ZtSlowask", archetype: "provider", scopes: {}, optional: { net: ["b.test"] }, methods: { go: { ...m(), deadlineMs: 300 } } }, `{ go: async () => powers.call("fetch", { url: "https://b.test/" }) }`)
    const slowDeny = () => Effect.andThen(Effect.sleep(700), Effect.succeed("deny" as const))
    const e = await runWith(() => [asker], approved([asker], { ask: slowDeny }), Effect.flip(PluginHost.use((h) => h.call("zt-slowask/go", {}))))
    expect(e.message).toContain("denied")
  })
})

describe("PluginHost.calls", () => {
  test("runs tool calls in order under one hold of the lock; a failure says what was touched so far", async () => {
    const out = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        const ok = (yield* host.calls([{ name: "notes/add-topic", params: { name: "a" } }, { name: "notes/add-note", params: { text: "x", topic: "T-0001" } }])).touched
        const bad = yield* Effect.flip(host.calls([{ name: "notes/add-topic", params: { name: "b" } }, { name: "notes/add-note", params: { text: "y", topic: "T-0999" } }]))
        // The lock is free again: a plain call goes through.
        const after = yield* host.call("notes/add-topic", { name: "c" })
        return { ok, bad: { touched: bad.touched, tag: bad.error._tag }, after: after.added }
      }),
    )
    expect(out.ok).toEqual(["T-0001", "N-0001"])
    expect(out.bad).toEqual({ touched: ["T-0002"], tag: "ToolError" })
    expect(out.after).toEqual(["T-0003"])
  })
})
