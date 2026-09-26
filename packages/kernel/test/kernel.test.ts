import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Kernel } from "../src"
import { notes } from "./fixtures"

const withKernel = <A>(f: (k: Kernel.Kernel, n: ReturnType<typeof notes>) => Effect.Effect<A>, opts: { timeoutMs?: number; outputCap?: number } = {}) => {
  const n = notes()
  return Effect.runPromise(Effect.scoped(Effect.flatMap(Kernel.make({ services: [n.bound], ...opts }), (k) => f(k, n))))
}

describe("Kernel", () => {
  test("returns the cell's value and its console lines", async () => {
    const r = await withKernel((k) => k.run('console.log("hello", { a: 1 })\nreturn { answer: 42 }'))
    expect(r).toEqual({ ok: true, output: 'hello {"a":1}\n{\n  "answer": 42\n}', restarted: false })
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

  test("a failed call fails the cell with its tag, or is caught with Effect.catch", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        const uncaught = yield* k.run("return yield* Notes.fail({})")
        const caught = yield* k.run("return yield* Effect.catch(Notes.fail({}), (e) => Effect.succeed(`caught ${e._tag}`))")
        return { uncaught, caught }
      }),
    )
    expect(out.uncaught).toEqual({ ok: false, output: "error: Nope: always fails", restarted: false })
    expect(out.caught.output).toBe("caught Nope")
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
})
