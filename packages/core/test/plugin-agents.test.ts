import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeLog } from "../src/log"
import { defineView, layoutOf } from "@zarg/view"
import { initial, reduce } from "@zarg/client"
import { pluginAgents } from "../src/plugin-agents"
import { DEFAULT_LAYOUT, threadViews } from "../src/views"

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

test("a plugin agent starts with its declared view; step lines go to its first log; set and append reach it", async () => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-pa-")), (t) => t))
  const tester = layoutOf(defineView("tester", { steps: { kind: "log", role: "log" }, progress: { kind: "stats", role: "summary" } }))
  const on = pluginAgents(log, "main", (plugin, view) => (plugin === "rehearse" && view === "tester" ? tester : undefined))
  on("rehearse", { event: "start", id: "tester-1", title: "tester", task: "The developer", view: "tester" })
  on("rehearse", { event: "step", id: "tester-1", text: "UX-1 ok" })
  on("rehearse", { event: "set", id: "tester-1", section: "progress", data: { items: [] } })
  threadViews(log, "main").flush()
  const views = log.all().filter((e) => (e as { activityType?: string }).activityType === "zarg.view") as ReadonlyArray<Record<string, any>>
  expect(views[0]).toMatchObject({ type: "ACTIVITY_SNAPSHOT", content: { agent: "rehearse:tester-1", layout: tester } })
  expect(views[1]!.patch).toEqual([{ op: "add", path: "/data/steps/lines/-", value: { text: "UX-1 ok" } }, { op: "replace", path: "/data/progress", value: { items: [] } }])
})

test("a push for an agent this plugin did not start is refused, and so is an undeclared view", async () => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-pa-")), (t) => t))
  const on = pluginAgents(log, "main", () => undefined)
  on("other", { event: "start", id: "x", title: "t", task: "t" })
  expect(() => on("rehearse", { event: "append", id: "x", section: "history", lines: [{ text: "hi" }] })).toThrow(/no view/)
  expect(() => on("rehearse", { event: "start", id: "y", title: "t", task: "t", view: "missing" })).toThrow(/declares no view missing/)
})

test("an agent started without a view gets the default: its step lines in one log", async () => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-pa-")), (t) => t))
  const on = pluginAgents(log, "main", () => undefined)
  on("p", { event: "start", id: "a", title: "t", task: "t" })
  on("p", { event: "step", id: "a", text: "one" })
  threadViews(log, "main").flush()
  const snap = log.all().find((e) => e.type === "ACTIVITY_SNAPSHOT" && (e as { activityType?: string }).activityType === "zarg.view") as Record<string, any>
  expect(snap.content.layout).toEqual(DEFAULT_LAYOUT)
})

test("an agent asks for attention on its row; clearing or ending takes it away", async () => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-pa-")), (t) => t))
  const on = pluginAgents(log, "main", () => undefined)
  const row = () => log.all().filter((e) => e.threadId === "main").reduce(reduce, initial("main")).rlms["rehearse:tester-1"]
  on("rehearse", { event: "start", id: "tester-1", title: "tester", task: "t" })
  on("rehearse", { event: "attention", id: "tester-1", reason: "4 findings to review" })
  expect(row()?.attention?.reason).toBe("4 findings to review")
  on("rehearse", { event: "attention", id: "tester-1" })
  expect(row()?.attention).toBeUndefined()
  on("rehearse", { event: "attention", id: "tester-1", reason: "again" })
  on("rehearse", { event: "end", id: "tester-1", ok: true })
  expect(row()?.attention).toBeUndefined()
})
