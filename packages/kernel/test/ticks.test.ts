import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Kernel, type Recorded } from "../src"

const run = (cell: string, clock?: Parameters<typeof Kernel.make>[0]["clock"]) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const records: Array<Recorded> = []
    const k = yield* Kernel.make({ services: [], ...(clock ? { clock } : {}), record: (r) => records.push(r) })
    const out = yield* k.run(cell)
    return { out, records }
  })))

const cell = `const a = Date.now()
const b = Math.random()
const c = crypto.randomUUID()
const d = performance.now()
const e = new Date().getTime()
return [a, b, c, d, e].join(",")`

describe("cell clocks", () => {
  test("a cell's reads of time and randomness are recorded in order", async () => {
    const r = await run(cell)
    expect(r.out.ok).toBe(true)
    const ticks = r.records.filter((x) => x.kind === "tick")
    expect(ticks.map((t) => (t as { source: string }).source)).toEqual(["date", "random", "uuid", "perf", "date"])
    expect(r.out.output).toBe(ticks.map((t) => (t as { value: unknown }).value).join(","))
  })

  test("replay serves the recorded values and returns the recorded output", async () => {
    const live = await run(cell)
    const ticks = live.records.filter((x) => x.kind === "tick").map(({ source, value }: any) => ({ source, value }))
    const again = await run(cell, { mode: "replay", ticks })
    expect(again.out.output).toBe(live.out.output)
  })

  test("reads past the recording continue deterministically and are reported", async () => {
    const two = `return [Date.now(), Date.now(), Math.random()].join(",")`
    const ticks = [{ source: "date" as const, value: 1000 }]
    const a = await run(two, { mode: "replay", ticks })
    const b = await run(two, { mode: "replay", ticks })
    expect(a.out.output).toBe(b.out.output)
    expect(a.out.output.startsWith("1000,1001,")).toBe(true)
    expect(a.records.filter((x) => x.kind === "extra").map((x: any) => x.source)).toEqual(["date", "random"])
  })

  test("a sleep replays instantly", async () => {
    const sleepy = `yield* Effect.sleep("30 seconds")\nreturn "woke"`
    const t = Date.now()
    const r = await run(sleepy, { mode: "replay", ticks: [] })
    expect(r.out.output).toBe("woke")
    expect(Date.now() - t).toBeLessThan(2000)
  })

  test("reads are counted per cell and capped at 10 000 ticks, then summarised", async () => {
    const r = await run(`let x = 0\nfor (let i = 0; i < 20000; i++) x += Date.now() > 0 ? 1 : 0\nreturn x`)
    expect(r.out.output).toBe("20000")
    const ticks = r.records.filter((x) => x.kind === "tick")
    expect(ticks.length).toBe(10_000)
    expect(r.records.some((x) => x.kind === "extra")).toBe(false)
  })
})
