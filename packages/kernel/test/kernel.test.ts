import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Kernel } from "../src"
import { notes } from "./fixtures"

const withKernel = <A>(
  f: (k: Kernel.Kernel, n: ReturnType<typeof notes>) => Effect.Effect<A>,
  opts: { timeoutMs?: number; outputCap?: number; env?: Record<string, string> } = {},
) => {
  const n = notes()
  return Effect.runPromise(Effect.scoped(Effect.flatMap(Kernel.make({ services: [n.bound], ...opts }), (k) => f(k, n))))
}

describe("Kernel", () => {
  test("returns the cell's value and its console lines", async () => {
    const r = await withKernel((k) => k.run('console.log("hello", { a: 1 })\nreturn { answer: 42 }'))
    expect(r).toMatchObject({ ok: true, output: 'hello {"a":1}\n{\n  "answer": 42\n}', restarted: false })
  })

  test("service calls cross to the host and back, typed", async () => {
    const r = await withKernel((k) => k.run('const { id } = yield* Notes.add({ text: "x" })\nreturn yield* Notes.get({ id })'))
    expect(r.output).toBe("x")
  })

  test("top-level declarations persist into later cells", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        yield* k.run('const saved = yield* Notes.add({ text: "keep" })')
        return yield* k.run("return yield* Notes.get({ id: saved.id })")
      }),
    )
    expect(out.output).toBe("keep")
  })

  test("functions and classes declared in one cell are usable in the next", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        yield* k.run("function double(n: number) { return n * 2 }\nclass Box { constructor(readonly v: number) {} }")
        return yield* k.run("return double(new Box(21).v)")
      }),
    )
    expect(out.output).toBe("42")
  })

  test("a cell that fails its typecheck does not run", async () => {
    const r = await withKernel((k, n) =>
      Effect.map(k.run('yield* Notes.add({ text: "never" })\nyield* Fs.read({ path: "x" })'), (res) => ({ res, calls: n.seen.calls })),
    )
    expect(r.res.ok).toBe(false)
    expect(r.res.output).toContain("typecheck failed, the cell did not run")
    expect(r.res.output).toContain("line 2: Cannot find name 'Fs'.")
    expect(r.calls).toBe(0)
  })

  test("a method call on an effect (.catch, .pipe) says how to write it instead", async () => {
    const r = await withKernel((k) => k.run('const x = yield* Notes.add({ text: "a" }).catch(() => Effect.succeed(null))\nreturn x'))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("Property 'catch' does not exist")
    expect(r.output).toContain("Effect.catch(Svc.m(p), (e) => Effect.succeed(null))")
  })

  test("untyped values (from earlier cells, empty objects) do not fail the typecheck", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        yield* k.run('const text = "a\\nvm b\\nc"\nreturn 0')
        return yield* k.run('const counts = {}\nfor (const l of text.split("\\n").filter(l => l.includes("b"))) counts[l] = (counts[l] || 0) + 1\nreturn counts')
      }),
    )
    expect(out).toMatchObject({ ok: true, output: '{\n  "vm b": 1\n}' })
  })

  test("a failed call fails the cell with its tag, or is caught with Effect.catch", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        const uncaught = yield* k.run("return yield* Notes.fail({})")
        const caught = yield* k.run("return yield* Effect.catch(Notes.fail({}), (e) => Effect.succeed(`caught ${e._tag}`))")
        return { uncaught, caught }
      }),
    )
    expect(out.uncaught).toMatchObject({ ok: false, output: "error: Nope: always fails", restarted: false })
    expect(out.caught.output).toBe("caught Nope")
  })

  test("a file write that breaks the syntax is told how to pass a file's content", async () => {
    const out = await withKernel((k) => k.run("// Fs.write({ path: 'a.ts', content: `x ${'${'} y` })\nconst broken = {"))
    expect(out.ok).toBe(false)
    expect(out.output).toContain("write it as an array of lines")
  })

  test("a cell that fails after calls that took effect says which: the model does not repeat them", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        const failed = yield* k.run('yield* Notes.add({ text: "x" })\nreturn yield* Notes.fail({})')
        const next = yield* k.run("return yield* Notes.fail({})")
        return { failed, next }
      }),
    )
    expect(out.failed.output).toBe('error: Nope: always fails\nBefore it failed, these calls ran and their effects stay (do not repeat them):\n- Notes.add → {"id":"n1"}')
    expect(out.next.output).toBe("error: Nope: always fails")
  })

  test("params that break the schema at runtime are refused by the host", async () => {
    const r = await withKernel((k) => k.run("return yield* Notes.add({ text: 5 } as any)"))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("InvalidParams")
  })

  test("a thrown exception is reported", async () => {
    const r = await withKernel((k) => k.run('throw new Error("boom")'))
    expect(r).toMatchObject({ ok: false })
    expect(r.output).toContain("boom")
  })

  test("a cell past its deadline restarts the kernel; globals are gone", async () => {
    const out = await withKernel(
      (k) =>
        Effect.gen(function* () {
          yield* k.run("const before = 1")
          const slow = yield* k.run("while (true) {}")
          const after = yield* k.run("return before")
          const fresh = yield* k.run("return 'alive'")
          return { slow, after, fresh }
        }),
      { timeoutMs: 300 },
    )
    expect(out.slow).toMatchObject({ ok: false, restarted: true })
    expect(out.slow.output).toContain("kernel was restarted")
    expect(out.after.output).toContain("Cannot find name 'before'")
    expect(out.fresh.output).toBe("alive")
  })

  test("time spent yielded on a host call does not count toward the deadline", async () => {
    const out = await withKernel((k) => k.run("return yield* Notes.slow({ ms: 600 })"), { timeoutMs: 200 })
    expect(out).toMatchObject({ ok: true, output: "slept", restarted: false })
  })

  test("time running in the worker between calls still counts", async () => {
    const out = await withKernel(
      (k) => k.run('yield* Notes.slow({ ms: 50 })\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)\nreturn "done"'),
      { timeoutMs: 300 },
    )
    expect(out).toMatchObject({ ok: false, restarted: true })
  })

  test("interrupting a cell interrupts its host-side calls", async () => {
    const seen = await withKernel((k, n) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(k.run("return yield* Notes.slow({ ms: 5000 })"))
        yield* Effect.sleep(100)
        yield* Fiber.interrupt(fiber)
        yield* Effect.sleep(50)
        return n.seen.interrupted
      }),
    )
    expect(seen).toBe(1)
  })

  test("large output is capped with a note", async () => {
    const r = await withKernel((k) => k.run("return 'x'.repeat(5000)"), { outputCap: 1000 })
    expect(r.output.length).toBeLessThan(1100)
    expect(r.output).toContain("characters cut")
  })

  test("names declared before a failed service call still persist", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        yield* k.run("const e1 = 1\nyield* Notes.fail({})\nconst e2 = 2")
        return yield* k.run("return e1")
      }),
    )
    expect(out).toMatchObject({ ok: true, output: "1", restarted: false })
  })

  test("a console flood is capped as it arrives and cannot exhaust host memory", async () => {
    const r = await withKernel((k) => k.run('for (let i = 0; i < 2000; i++) console.log("x".repeat(100000))\nreturn "end"'), { outputCap: 2000 })
    expect(r.ok).toBe(true)
    expect(r.output.length).toBeLessThan(2200)
    expect(r.output).toContain("characters cut")
    expect(r.output.endsWith("end")).toBe(true)
  }, 20_000)

  test("a crashed worker is noticed at once and replaced", async () => {
    const out = await withKernel(
      (k) =>
        Effect.gen(function* () {
          const started = Date.now()
          const crash = yield* k.run("(globalThis as any).setTimeout(() => { throw new Error('async boom') }, 0)\nreturn yield* Notes.slow({ ms: 200 })")
          const next = yield* k.run("return 'alive'")
          return { crash, next, ms: Date.now() - started }
        }),
      { timeoutMs: 5000 },
    )
    expect(out.crash).toMatchObject({ ok: false, restarted: true })
    expect(out.crash.output).toContain("async boom")
    expect(out.next.output).toBe("alive")
    expect(out.ms).toBeLessThan(3000)
  })

  test("a value JSON cannot encode is an error, not a hang", async () => {
    const r = await withKernel((k) => k.run("return 1n"), { timeoutMs: 3000 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("could not format the return value")
  })

  test("shadowing JSON in a cell does not break later cells", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        yield* k.run("const JSON = 1")
        return yield* k.run("return { a: 1 }")
      }),
    )
    expect(out.output).toBe('{\n  "a": 1\n}')
  })

  test("interrupting a CPU-bound cell replaces the worker quickly", async () => {
    const ms = await withKernel(
      (k) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(k.run("while (true) {}"))
          yield* Effect.sleep(100)
          yield* Fiber.interrupt(fiber)
          const started = Date.now()
          const next = yield* k.run("return 'alive'")
          expect(next.output).toBe("alive")
          return Date.now() - started
        }),
      { timeoutMs: 10_000 },
    )
    expect(ms).toBeLessThan(3000)
  })

  test("concurrent runs are serialized, not mixed up", async () => {
    const [a, b] = await withKernel((k) =>
      Effect.all([k.run("return yield* Notes.slow({ ms: 300 })"), k.run("return 2")], { concurrency: 2 }),
    )
    expect(a).toMatchObject({ ok: true, output: "slept", restarted: false })
    expect(b).toMatchObject({ ok: true, output: "2", restarted: false })
  })

  test("calls made after a cell finished are refused", async () => {
    const calls = await withKernel((k, n) =>
      Effect.gen(function* () {
        yield* k.run('(globalThis as any).setInterval(() => (Effect as any).runPromise(Notes.add({ text: "late" })), 20)\nreturn "done"')
        yield* Effect.sleep(200)
        return n.seen.calls
      }),
    )
    expect(calls).toBe(0)
  })

  test("non-JSON schema types cross as their JSON encoding", async () => {
    const r = await withKernel((k) => k.run('const r = yield* Notes.echoDate({ at: "2020-01-02T03:04:05.000Z" })\nreturn typeof r.at + " " + r.at'))
    expect(r.output).toBe("string 2020-01-02T03:04:05.000Z")
  })

  test("the worker gets only the environment it is given", async () => {
    expect(process.env.HOME).toBeDefined()
    const out = await withKernel((k) => k.run("const env = (globalThis as any).process.env\nreturn [String(env.HOME), String(env.KEEP)].join(' ')"), { env: { KEEP: "1" } })
    expect(out.output).toBe("undefined 1")
  })
})
