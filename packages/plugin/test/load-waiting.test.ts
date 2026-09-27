import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeGrants, scopesDigest } from "../src/runtime"
import { fixturePlugin, hostWith } from "./fixtures"

// Plugins that need a load grant (they read files): waiting until YOLO or the developer lets them load.
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
