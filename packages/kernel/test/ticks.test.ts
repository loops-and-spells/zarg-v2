import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Kernel, type Recorded } from "../src"

const runAll = (cells: ReadonlyArray<string>, clock?: Parameters<typeof Kernel.make>[0]["clock"]) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const records: Array<Recorded> = []
    const k = yield* Kernel.make({ services: [], ...(clock ? { clock } : {}), record: (r) => records.push(r) })
    const outs = []
    for (const c of cells) outs.push(yield* k.run(c))
    return { outs, out: outs.at(-1)!, records }
  })))
const run = (cell: string, clock?: Parameters<typeof Kernel.make>[0]["clock"]) => runAll([cell], clock)
const ticksOf = (records: ReadonlyArray<Recorded>) => records.flatMap((r) => (r.kind === "tick" ? [r] : []))

const cell = `const a = yield* Clock.currentTimeMillis
const b = yield* Random.next
const c = yield* Random.nextIntBetween(1, 6)
const d = yield* Random.shuffle([1, 2, 3])
return [a, b, c, d.join("")].join(",")`

describe("cell clocks", () => {
  test("a cell's reads of time and randomness through Clock and Random are recorded in order", async () => {
    const r = await run(cell)
    expect(r.out.ok).toBe(true)
    const ticks = ticksOf(r.records)
    expect(ticks[0]!.source).toBe("clock")
    expect(ticks.slice(1).every((t) => t.source === "random")).toBe(true)
    expect(r.out.output.split(",")[0]).toBe(String(ticks[0]!.value))
  })

  test("replay serves the recorded values and returns the recorded output", async () => {
    const live = await run(cell)
    const ticks = ticksOf(live.records).map(({ source, value }) => ({ source, value }))
    const again = await run(cell, { mode: "replay", ticks })
    expect(again.out.output).toBe(live.out.output)
  })

  test("reads past the recording continue deterministically and are reported", async () => {
    const two = `return [yield* Clock.currentTimeMillis, yield* Clock.currentTimeMillis, yield* Random.next].join(",")`
    const ticks = [{ source: "clock" as const, value: 1000 }]
    const a = await run(two, { mode: "replay", ticks })
    const b = await run(two, { mode: "replay", ticks })
    expect(a.out.output).toBe(b.out.output)
    expect(a.out.output.startsWith("1000,1001,")).toBe(true)
    expect(a.records.flatMap((x) => (x.kind === "extra" ? [x.source] : []))).toEqual(["clock", "random"])
  })

  test("a sleep replays instantly", async () => {
    const t = Date.now()
    const r = await run(`yield* Effect.sleep("30 seconds")\nreturn "woke"`, { mode: "replay", ticks: [] })
    expect(r.out.output).toBe("woke")
    expect(Date.now() - t).toBeLessThan(2000)
  })

  test("reads are capped at 10 000 ticks per cell, then one truncated record says so", async () => {
    const r = await run(`let x = 0\nfor (let i = 0; i < 12000; i++) x += (yield* Random.next) < 1 ? 1 : 0\nreturn x`)
    expect(r.out.output).toBe("12000")
    expect(ticksOf(r.records).length).toBe(10_000)
    expect(r.records.filter((x) => x.kind === "truncated")).toEqual([{ kind: "truncated", cell: 1, source: "random" }])
  })

  test("a function from an earlier cell reads the clock of the cell that calls it", async () => {
    const r = await runAll([`const stamp = () => Clock.currentTimeMillis\nreturn 0`, `return yield* stamp()`])
    expect(r.out.ok).toBe(true)
    expect(ticksOf(r.records).map((t) => t.cell)).toEqual([2])
  })
})

describe("real time and randomness are refused", () => {
  test.each([
    ["Date.now()", "Clock.currentTimeMillis"],
    ["new Date()", "Clock.currentTimeMillis"],
    ["Date()", "Clock.currentTimeMillis"],
    ["Math.random()", "Random.next"],
    ["performance.now()", ""],
    ["crypto.randomUUID()", ""],
  ])("%s does not typecheck, and the error names the service to use", async (expr, hint) => {
    const r = await run(`return ${expr}`)
    expect(r.out.ok).toBe(false)
    expect(r.out.output).toContain("typecheck failed")
    expect(r.out.output).toContain(hint)
  })

  test("pure date work still typechecks and runs", async () => {
    const r = await run(`const d = new Date(0)\nreturn [d.toISOString(), Date.parse("1970-01-02T00:00:00Z"), Date.UTC(1970, 0, 1), d instanceof Date].join(",")`)
    expect(r.out.output).toBe("1970-01-01T00:00:00.000Z,86400000,0,true")
  })

  test("a cell that escapes the typecheck still cannot read the real clock", async () => {
    const r = await run(`return (Date as any).now()`)
    expect(r.out.ok).toBe(false)
    expect(r.out.output).toContain("Clock.currentTimeMillis")
    const m = await run(`return (Math as any).random()`)
    expect(m.out.output).toContain("Random.next")
  })

  test("a Date made in one cell is still a Date in the next", async () => {
    const r = await runAll([`const d = new Date(5)\nreturn 0`, `return d instanceof Date`])
    expect(r.out.output).toBe("true")
  })
})
