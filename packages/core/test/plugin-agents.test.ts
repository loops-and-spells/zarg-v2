import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeLog } from "../src/log"
import { pluginAgents } from "../src/plugin-agents"

test("agent ids are namespaced and checked; events become main's activity in the plugin's stream and its history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zarg-pa-"))
  const log = await Effect.runPromise(makeLog(dir, (t) => t))
  const sink = pluginAgents(log, "main")
  sink("rehearse", { event: "start", id: "run", title: "rehearse", task: "run r-1" })
  sink("rehearse", { event: "start", id: "tester-1", parent: "run", title: "tester", task: "The developer" })
  sink("rehearse", { event: "step", id: "tester-1", text: "UX-0001: feel 1.80" })
  sink("rehearse", { event: "status", id: "tester-1", progress: { done: 1, total: 4 }, text: "1/4 steps" })
  expect(() => sink("rehearse", { event: "start", id: "a:b", title: "x", task: "y" })).toThrow("agent id")
  const events = readFileSync(join(dir, "main.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const paths = events.filter((e) => e.type === "ACTIVITY_DELTA").map((e) => [e.messageId, e.patch[0].path, e.patch[0].value.parent])
  expect(paths[0]).toEqual(["main-rehearse-agents", "/rlms/rehearse:run", null])
  expect(paths[1]).toEqual(["main-rehearse-agents", "/rlms/rehearse:tester-1", "rehearse:run"])
  expect(log.history("main", "rehearse:tester-1").map((l) => l.type)).toEqual(["start", "step"])
})
