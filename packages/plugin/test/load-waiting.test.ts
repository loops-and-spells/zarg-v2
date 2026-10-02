import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { makeGrants, scopesDigest } from "../src/runtime"
import { fixturePlugin, hostWith } from "./fixtures"

// Plugins that need a load grant (they read files): waiting until YOLO or the operator lets them load.
const plugin = (name: string, deps?: string) => `
import { Effect, Schema } from "effect"
import { definePlugin, pluginContract } from "@zarg/plugin-sdk"
const C = pluginContract("${name}", { hello: { params: Schema.Struct({}), success: Schema.String } })
${deps !== undefined ? `const D = pluginContract("${deps}", { hello: { params: Schema.Struct({}), success: Schema.String } })` : ""}
export default definePlugin({ name: "${name}", service: "S${name.replace(/-/g, "")}", archetype: "service", config: Schema.Struct({}), scopes: { fs: { read: ["docs/**"] } }, implements: C,
  ${deps !== undefined ? "pluginDependencies: [D]," : ""}
  methods: { hello: { doc: "hi", params: Schema.Struct({}), success: Schema.String } },
  make: ${deps !== undefined ? `Effect.gen(function* () { const d = yield* D; return { hello: () => Effect.map(d.hello({}), (s) => "${name} after " + s) } })` : `Effect.succeed({ hello: () => Effect.succeed("hi from ${name}") })`} })`

const grantsFile = () => join(mkdtempSync(join(tmpdir(), "zt-wait-")), "grants.json")

describe("plugins waiting on a load grant", () => {
  // @card C-0067
  test("with YOLO on they load without a question, and nothing is saved", async () => {
    const file = grantsFile()
    const asked: Array<string> = []
    const out = await Effect.runPromise(
      hostWith(
        [await fixturePlugin(plugin("base"))],
        (h) =>
          Effect.gen(function* () {
            const before = yield* Effect.exit(h.invoke("base", "hello", {}))
            yield* h.loadWaiting
            return { before: before._tag, after: yield* h.invoke("base", "hello", {}), agenda: (yield* h.agenda()).map((i) => i.id) }
          }),
        { grants: Effect.runSync(makeGrants({ file, project: "/zt/project" })), firstParty: () => false, yolo: { on: () => true }, ask: (q) => Effect.sync(() => (asked.push(q.what), "deny" as const)) },
      ),
    )
    expect(out).toEqual({ before: "Failure", after: "hi from base", agenda: [] })
    expect(asked).toEqual([])
    const g = Effect.runSync(makeGrants({ file, project: "/zt/project" }))
    expect(Effect.runSync(g.of("base", scopesDigest({ fs: { read: ["docs/**"] } }, {}))).loaded).toBe(false)
  })

  // @card C-0061
  test("without YOLO the developer is asked: Allow saves the grant and loads it now; its dependent follows", async () => {
    const file = grantsFile()
    const asked: Array<string> = []
    const out = await Effect.runPromise(
      hostWith(
        [await fixturePlugin(plugin("base")), await fixturePlugin(plugin("user", "base"))],
        (h) =>
          Effect.gen(function* () {
            yield* h.loadWaiting
            return yield* h.invoke("user", "hello", {})
          }),
        { grants: Effect.runSync(makeGrants({ file, project: "/zt/project" })), firstParty: () => false, ask: (q) => Effect.sync(() => (asked.push(`${q.plugin}: ${q.what}`), "always" as const)) },
      ),
    )
    expect(out).toBe("user after hi from base")
    expect(asked.map((a) => a.split(":")[0])).toEqual(["base", "user"])
    expect(asked[0]).toContain("read docs/**")
    const g = Effect.runSync(makeGrants({ file, project: "/zt/project" }))
    expect(Effect.runSync(g.of("base", scopesDigest({ fs: { read: ["docs/**"] } }, {}))).loaded).toBe(true)
  })

  test("Not now leaves it waiting, not loaded, with its item for the developer", async () => {
    const out = await Effect.runPromise(
      hostWith(
        [await fixturePlugin(plugin("base"))],
        (h) =>
          Effect.gen(function* () {
            yield* h.loadWaiting
            return { call: (yield* Effect.exit(h.invoke("base", "hello", {})))._tag, agenda: (yield* h.agenda()).map((i) => i.id) }
          }),
        { grants: Effect.runSync(makeGrants({ file: grantsFile(), project: "/zt/project" })), firstParty: () => false, ask: () => Effect.succeed("deny" as const) },
      ),
    )
    expect(out).toEqual({ call: "Failure", agenda: ["plugin-grant:base"] })
  })

  test("a service plugin starts when it loads (a run cut short by a restart resumes), not on its first call", async () => {
    const src = `
import { Effect, Schema } from "effect"
import { Agents, definePlugin } from "@zarg/plugin-sdk"
export default definePlugin({ name: "resumer", service: "Resumer", archetype: "service", config: Schema.Struct({}), scopes: { agents: true },
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.Null } },
  make: Effect.gen(function* () { yield* (yield* Agents).start({ id: "resumed", title: "t", task: "picked up where it was" }); return { go: () => Effect.succeed(null) } }) })`
    const events: Array<unknown> = []
    await Effect.runPromise(hostWith([await fixturePlugin(src)], () => Effect.sleep(300), { agents: (_p, e) => void events.push(e) }))
    expect(events).toContainEqual(expect.objectContaining({ event: "start", id: "resumed" }))
  })
})

describe("agent plugins", () => {
  const agent = (runtime?: string) => `
import { Effect, Schema } from "effect"
import { Agents, definePlugin } from "@zarg/plugin-sdk"
export default definePlugin({ name: "walker", service: "Walker", archetype: "agent", ${runtime !== undefined ? `runtime: "${runtime}",` : ""} config: Schema.Struct({}), scopes: { agents: true },
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.String } },
  make: Effect.gen(function* () { yield* (yield* Agents).start({ id: "w", title: "walker", task: "walks" }); return { go: () => Effect.succeed("walking") } }) })`

  test("a sandboxed agent loads, starts at load and answers calls", async () => {
    const events: Array<unknown> = []
    const out = await Effect.runPromise(hostWith([await fixturePlugin(agent())], (h) => Effect.andThen(Effect.sleep(200), h.invoke("walker", "go", {})), { agents: (_p, e) => void events.push(e) }))
    expect(out).toBe("walking")
    expect(events).toContainEqual(expect.objectContaining({ event: "start", id: "w" }))
  })

  test("the host refuses an action mapped to a reserved key", async () => {
    const built = await fixturePlugin(agent())
    // The SDK refuses this at build; a hand-made manifest reaches the host, which must refuse it too.
    const views = [{ name: "w", sections: [{ id: "t", kind: "table", role: "primary", columns: [], actions: [{ id: "a", label: "A", key: "tab", on: "row" }] }] }]
    const out = await Effect.runPromise(hostWith([{ ...built, manifest: { ...built.manifest, views } as never }], (h) => Effect.map(h.agenda(), (a) => a.map((i) => i.detail).join(" "))))
    expect(out).toContain("tab, a key terminal keeps for itself")
  })

  test("the host refuses a surface showing a view the plugin does not declare", async () => {
    const built = await fixturePlugin(agent())
    const out = await Effect.runPromise(hostWith([{ ...built, manifest: { ...built.manifest, surfaces: [{ kind: "sheet", name: "s", view: "missing" }] } as never }], (h) => Effect.map(h.agenda(), (a) => a.map((i) => i.detail).join(" "))))
    expect(out).toMatch(/view missing, which the plugin does not declare/)
  })

  test("a bundle that claims the trusted runtime is refused: trusted agents are zarg's own packages", async () => {
    const out = await Effect.runPromise(hostWith([await fixturePlugin(agent("trusted"))], (h) => Effect.map(h.agenda(), (a) => a.map((i) => i.detail).join(" "))))
    expect(out).toContain("trusted")
  })
})

describe("a sandboxed agent's conversation", () => {
  test("a question the developer takes a while to answer does not trip the call's deadline", async () => {
    const src = `
import { Effect, Schema } from "effect"
import { Conversation, definePlugin, defineView } from "@zarg/plugin-sdk"
const Talk = defineView("talk", { talk: { kind: "conversation", role: "primary" } })
export default definePlugin({ name: "asker", service: "Asker", archetype: "agent", config: Schema.Struct({}), scopes: { agents: true }, views: [Talk],
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.String, deadlineMs: 100 } },
  make: Effect.gen(function* () { const c = yield* Conversation; return { go: () => Effect.map(c.ask("a-1", { question: "Go?", options: [{ id: "y", label: "Yes" }] }), (a) => a.choice ?? "") } }) })`
    const pushes: Array<{ event: string; data?: { question?: { id: string } } }> = []
    const out = await Effect.runPromise(
      hostWith(
        [await fixturePlugin(src)],
        (h) =>
          Effect.gen(function* () {
            const going = yield* Effect.forkChild(h.invoke("asker", "go", {}))
            yield* Effect.sleep(400)
            const q = pushes.findLast((p) => p.event === "set")?.data?.question?.id ?? ""
            yield* h.invoke("asker", "$answer", { agent: "a-1", question: q, answer: { choice: "y" } })
            return yield* Fiber.join(going)
          }),
        { agents: (_p, e) => void pushes.push(e as never) },
      ),
    )
    expect(out).toBe("y")
  })
})
