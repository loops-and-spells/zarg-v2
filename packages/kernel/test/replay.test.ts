import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Kernel, type Recorded, replay } from "../src"
import { Notes, notes } from "./fixtures"

const recordRun = (code: string) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const records: Array<Recorded> = []
    const k = yield* Kernel.make({ services: [notes().bound], record: (r) => records.push(r) })
    const out = yield* k.run(code)
    const calls = records.filter((r) => r.kind === "call").map(({ kind, ...c }: any) => c)
    const ticks = records.filter((r) => r.kind === "tick").map(({ source, value }: any) => ({ source, value }))
    return { out, calls, ticks }
  })))
const again = (code: string, rec: Awaited<ReturnType<typeof recordRun>>) =>
  Effect.runPromise(replay({ code, defs: [Notes], calls: rec.calls, ticks: rec.ticks }))

describe("replay", () => {
  const code = `const a = yield* Notes.add({ text: "hi" })\nconst b = yield* Notes.get({ id: a.id })\nreturn [a.id, b, Date.now() > 0]`

  test("a recorded cell replays to the recorded output with no services behind it", async () => {
    const rec = await recordRun(code)
    const r = await again(code, rec)
    expect(r).toMatchObject({ ok: true, output: rec.out.output, divergences: [], unused: [], extraTicks: [] })
  })

  test("a changed param is a divergence at that call", async () => {
    const rec = await recordRun(code)
    const r = await again(code.replace(`{ text: "hi" }`, `{ text: "bye" }`), rec)
    expect(r.divergences).toEqual([{ at: 0, service: "Notes", method: "add", params: { text: "bye" }, reason: "no matching recorded call" }])
  })

  test("recorded calls the code never made are reported unused", async () => {
    const rec = await recordRun(code)
    const r = await again(`return yield* Notes.add({ text: "hi" })`, rec)
    expect(r.unused.map((c) => c.method)).toEqual(["get"])
  })

  test("concurrent calls replay in any order", async () => {
    const par = `return yield* Effect.all([Notes.add({ text: "a" }), Notes.add({ text: "b" }), Notes.add({ text: "c" })], { concurrency: 3 })`
    const rec = await recordRun(par)
    const shuffled = { ...rec, calls: [...rec.calls].reverse() }
    const r = await again(par, shuffled)
    expect(r.divergences).toEqual([])
    expect(r.output).toBe(rec.out.output)
  })

  test("a recorded failure replays as the same failure", async () => {
    const failing = `return yield* Effect.catch(Notes.get({ id: "nope" }), (e) => Effect.succeed(e._tag))`
    const rec = await recordRun(failing)
    const r = await again(failing, rec)
    expect(r.output).toBe(rec.out.output)
    expect(r.output).toBe("NotFound")
  })
})
