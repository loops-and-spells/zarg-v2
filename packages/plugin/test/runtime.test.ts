import { describe, expect, test } from "bun:test"
import { Effect, type Scope, Stream } from "effect"
import { spawnPlugin } from "../src/runtime"
import { bundle, crashing, echo, looping } from "./fixtures"

const run = <A>(e: Effect.Effect<A, unknown, Scope.Scope>) => Effect.runPromise(Effect.scoped(e))

describe("plugin process", () => {
  test("a call round-trips JSON through the plugin's process", async () => {
    const r = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "echo", bundle: echo, powers: {} })
      return [yield* p.call("echo", { x: [1, "a"] }), yield* p.call("add", { a: 2, b: 3 })]
    }))
    expect(r).toEqual([{ x: [1, "a"] }, 5])
  })

  test("a power call reaches the host handler and its answer comes back", async () => {
    const r = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "echo", bundle: echo, powers: { "secrets.get": async (a) => `value-of-${(a as { name: string }).name}` } })
      return yield* p.call("secret", { key: "ZT_KEY" })
    }))
    expect(r).toBe("value-of-ZT_KEY")
  })

  test("a call past its deadline fails, the process restarts, later calls work", async () => {
    const exits: Array<string> = []
    const r = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "loop", bundle: looping, powers: {}, deadlineMs: 300, onExit: (x) => exits.push(x) })
      const spun = yield* Effect.flip(p.call("spin", {}))
      return { tag: spun._tag, after: yield* p.call("ok", {}) }
    }))
    expect(r).toEqual({ tag: "Deadline", after: "ok" })
    expect(exits).toContain("deadline")
  })

  test("a thrown error comes back as PluginError with its message", async () => {
    const e = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "crash", bundle: crashing, powers: {} })
      return yield* Effect.flip(p.call("boom", {}))
    }))
    expect(e).toMatchObject({ _tag: "PluginError", message: "plugin failed on purpose" })
  })

  test("an unknown method is UnknownMethod", async () => {
    const e = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "echo", bundle: echo, powers: {} })
      return yield* Effect.flip(p.call("nope", {}))
    }))
    expect(e._tag).toBe("UnknownMethod")
  })

  test("a streaming method yields each chunk in order", async () => {
    const counter = bundle(`{ count: async function* ({ n }) { for (let i = 0; i < n; i++) yield i } }`)
    const r = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "count", bundle: counter, powers: {} })
      return [...(yield* Stream.runCollect(p.stream("count", { n: 3 })))]
    }))
    expect(r).toEqual([0, 1, 2])
  })

  test("a bundle that throws while loading is a PluginLoadError", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.flip(spawnPlugin({ name: "bad", bundle: "throw new Error('broken at load')", powers: {} }))))
    expect(e).toMatchObject({ _tag: "PluginLoadError", name: "bad" })
    expect(e.message).toContain("broken at load")
  })

  test("the process has an empty environment", async () => {
    process.env.ZT_RUNTIME_LEAK = "zt-should-not-reach-the-plugin"
    const probe = bundle(`{ env: async () => typeof process === "undefined" ? "no process" : JSON.stringify(process.env) }`)
    const r = await run(Effect.gen(function* () { const p = yield* spawnPlugin({ name: "env", bundle: probe, powers: {} }); return yield* p.call("env", {}) }))
    expect(r).toBe("no process")
    delete process.env.ZT_RUNTIME_LEAK
  })
})
