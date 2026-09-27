import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { closeStale, makeActivity } from "../src/activity"
import { ARCHIVE, makeArchive, parseTtl } from "../src/archive"
import { makeLog } from "../src/log"

const open = () => Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-arch-")), (t) => t))
const archives = (log: Awaited<ReturnType<typeof open>>) => log.all().filter((e) => e.type === "CUSTOM" && e.name === ARCHIVE).map((e) => e.value as Record<string, unknown>)
const start = (id: string, parent?: string) => ({ type: "start" as const, id, ...(parent !== undefined ? { parent } : {}), preset: "tester", task: "t", scope: {}, depth: 0, budget: { turns: 1, tokens: 0, wallMs: 0 } })

test("archive, restore and delete are events on the thread", async () => {
  const log = await open()
  const a = makeArchive(log, "main")
  a.archive(["rehearse:t1", "rehearse:t2"], "archived by you")
  a.restore(["rehearse:t2"])
  a.remove(["rehearse:t1"])
  expect(archives(log)).toEqual([
    { archive: ["rehearse:t1", "rehearse:t2"], reason: "archived by you", at: expect.any(Number) },
    { restore: ["rehearse:t2"] },
    { delete: ["rehearse:t1"] },
  ])
})

test("the sweep archives finished agents past the TTL, never running ones, ones asking for attention, zarg, or ones already archived", async () => {
  const log = await open()
  const act = makeActivity(log, "main", "main-rehearse-agents")
  for (const id of ["old", "fresh", "busy", "asking", "gone"]) act.observe(start(`rehearse:${id}`) as never)
  for (const id of ["old", "fresh", "asking", "gone"]) act.observe({ type: "end", id: `rehearse:${id}`, ok: true, turns: 1, tokens: 0 } as never)
  act.attention("rehearse:asking", "look")
  const a = makeArchive(log, "main")
  a.archive(["rehearse:gone"], "archived by you")
  const now = Date.now()
  // Everything ended just now: nothing is past a one-hour TTL yet.
  a.sweep(60 * 60_000, now)
  expect(archives(log)).toHaveLength(1)
  a.sweep(60 * 60_000, now + 2 * 60 * 60_000)
  expect(archives(log).at(-1)).toEqual({ archive: ["rehearse:old", "rehearse:fresh"], reason: "ttl (1h)", at: expect.any(Number) })
})

test("agents a restart stopped are reported so the core archives them; zarg is not", async () => {
  const log = await open()
  const act = makeActivity(log, "main", "main-rehearse-agents")
  act.observe(start("rehearse:t1") as never)
  const z = makeActivity(log, "main")
  z.observe({ ...start("zarg"), preset: "zarg" } as never)
  const stopped = await Effect.runPromise(closeStale(log))
  expect(stopped).toEqual([{ threadId: "main", ids: ["rehearse:t1"] }])
})

test("a TTL reads as hours, minutes or days; off turns the sweep off", () => {
  expect(parseTtl(undefined)).toBe(24 * 60 * 60_000)
  expect(parseTtl("30m")).toBe(30 * 60_000)
  expect(parseTtl("2d")).toBe(2 * 24 * 60 * 60_000)
  expect(parseTtl(12)).toBe(12 * 60 * 60_000)
  expect(parseTtl("off")).toBeUndefined()
  expect(() => parseTtl("soon")).toThrow(/ttl/)
})
