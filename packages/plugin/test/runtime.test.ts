import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("a deadline counts the call, not the restart before it: a plugin slower to load than the deadline still answers", async () => {
    const r = await run(Effect.gen(function* () {
      // Loading does a few hundred ms of busy work (SES has no clock); a call's deadline is 100 ms.
      const slow = `for (let i = 0; i < 5e8; i++) {}\n${looping}`
      const p = yield* spawnPlugin({ name: "loop", bundle: slow, powers: {}, deadlineMs: 100 })
      yield* Effect.flip(p.call("spin", {}))
      // The restart (a new process, lockdown, the bundle) takes longer than 100 ms; the call itself does not.
      return yield* p.call("ok", {})
    }))
    expect(r).toBe("ok")
  })

  test("a process that cannot start fails its call, and its load timer never fires afterwards", async () => {
    // Closing the scope removes the plugin's working directory, so the next start cannot spawn.
    const p = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "echo", bundle: echo, powers: {}, loadTimeoutMs: 1_000 })
      yield* p.stop
      return p
    }))
    const e = await Effect.runPromise(Effect.flip(p.call("echo", {})))
    expect(e._tag).toBe("PluginCrashed")
    // Past the load timeout: a timer left behind would throw here.
    await Bun.sleep(1_300)
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

describe("review fixes: the process", () => {
  test("a bundle that never finishes loading fails at the load deadline", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.flip(spawnPlugin({ name: "hang", bundle: "for (;;) {}", powers: {}, loadTimeoutMs: 500 }))))
    expect(e).toMatchObject({ _tag: "PluginLoadError", name: "hang" })
    expect(e.message).toContain("did not load")
  })
  test("a serve that returns no methods object is refused at load", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.flip(spawnPlugin({ name: "bad", bundle: "module.exports.default = { serve: () => 42 }", powers: {} }))))
    expect(e.message).toContain("methods")
  })
  test("the deadline stops while the plugin waits on the developer", async () => {
    let open = false
    const slowAsk = bundle(`{ ask: async () => powers.call("slow", {}) }`)
    const r = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({
        name: "asker", bundle: slowAsk, deadlineMs: 200, paused: () => open,
        powers: { slow: async () => { open = true; await Bun.sleep(600); open = false; return "answered" } },
      })
      return yield* p.call("ask", {})
    }))
    expect(r).toBe("answered")
  })
  test("an inherited name is not a power, and the core keeps running", async () => {
    const probe = bundle(`{ poke: async () => { for (const n of ["hasOwnProperty", "__proto__", "constructor"]) { try { await powers.call(n, {}) } catch (e) { if (e.tag !== "NotGranted") return "wrong: " + e.tag } } return "refused" } }`)
    const r = await run(Effect.gen(function* () { const p = yield* spawnPlugin({ name: "poke", bundle: probe, powers: { fetch: async () => 1 } }); return yield* p.call("poke", {}) }))
    expect(r).toBe("refused")
  })
  test("the plugin runs in an empty directory: a project's bunfig preload never runs in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zt-cwd-"))
    const marker = join(dir, "preload-ran")
    writeFileSync(join(dir, "pre.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`)
    writeFileSync(join(dir, "bunfig.toml"), `preload = ["./pre.ts"]\n[test]\npreload = ["./pre.ts"]\n`)
    const here = process.cwd()
    process.chdir(dir)
    try {
      await run(Effect.gen(function* () { const p = yield* spawnPlugin({ name: "echo", bundle: echo, powers: {} }); return yield* p.call("echo", {}) }))
    } finally {
      process.chdir(here)
    }
    expect(existsSync(marker)).toBe(false)
  })
  test("the bundle says who it is: loaded identity is reported to the host", async () => {
    const who = `module.exports.default = { name: "zt-who", service: "ZtWho", archetype: "provider", serve: () => ({}) }`
    const r = await run(Effect.gen(function* () { const p = yield* spawnPlugin({ name: "zt-who", bundle: who, powers: {} }); return p.identity }))
    expect(r).toEqual({ name: "zt-who", service: "ZtWho", archetype: "provider" })
  })
})
