import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { initial, reduce } from "@zarg/client"
import { closeStale } from "../src/activity"
import * as E from "../src/events"
import { makeLog } from "../src/log"

test("a starting core marks agents the previous core left running as stopped; finished ones stay as they were", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zarg-restart-"))
  const before = await Effect.runPromise(makeLog(dir, (t) => t))
  const node = (id: string, status: string) => ({ op: "add", path: `/rlms/${id.replaceAll("/", "~1")}`, value: { id, parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status, decisions: [] } })
  await Effect.runPromise(before.append("main", E.activitySnapshot("main-old-activity", { rlms: {} })))
  await Effect.runPromise(before.append("main", E.activityDelta("main-old-activity", [node("tester-1", "running"), node("tester-2", "done")])))
  await Effect.runPromise(before.append("plan", E.activitySnapshot("plan-activity", { rlms: {} })))
  await Effect.runPromise(before.append("plan", E.activityDelta("plan-activity", [node("S-1/rlm-1", "running")])))
  // The next core, on the same log.
  const log = await Effect.runPromise(makeLog(dir, (t) => t))
  await Effect.runPromise(closeStale(log))
  const main = log.all().filter((e) => e.threadId === "main").reduce(reduce, initial("main"))
  expect(main.rlms["tester-1"]).toMatchObject({ status: "stopped", error: "zarg restarted" })
  expect(main.rlms["tester-2"]!.status).toBe("done")
  const plan = log.all().filter((e) => e.threadId === "plan").reduce(reduce, initial("plan"))
  expect(plan.rlms["S-1/rlm-1"]!.status).toBe("stopped")
  // Nothing left running: a second start adds nothing.
  const n = log.all().length
  await Effect.runPromise(closeStale(log))
  expect(log.all().length).toBe(n)
})

test("attention from the previous core is cleared at start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zarg-restart-"))
  const before = await Effect.runPromise(makeLog(dir, (t) => t))
  await Effect.runPromise(before.append("main", E.activitySnapshot("main-p-agents", { rlms: {} })))
  await Effect.runPromise(before.append("main", E.activityDelta("main-p-agents", [{ op: "add", path: "/rlms/p:t", value: { id: "p:t", parent: null, preset: "tester", depth: 0, turns: 1, budget: 1, status: "done", decisions: [], attention: { reason: "look", since: 1 } } }])))
  const log = await Effect.runPromise(makeLog(dir, (t) => t))
  await Effect.runPromise(closeStale(log))
  const main = log.all().filter((e) => e.threadId === "main").reduce(reduce, initial("main"))
  expect(main.rlms["p:t"]!.attention).toBeUndefined()
})
