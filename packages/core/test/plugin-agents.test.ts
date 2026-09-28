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

import { makeSurfaces, NAVIGATE, PANELS } from "../src/surfaces"
import { makePrompts, PROMPT, PROMPT_DONE } from "../src/prompts"
import type { Surface } from "@zarg/view"

const surfaceSetup = async (surfaces: ReadonlyArray<Surface>) => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-pa-")), (t) => t))
  const layouts: Record<string, ReturnType<typeof layoutOf>> = {
    tester: layoutOf(defineView("tester", { progress: { kind: "stats", role: "summary" } })),
    status: layoutOf(defineView("status", { line: { kind: "stats", role: "summary" } })),
  }
  const on = pluginAgents(
    log,
    "main",
    (plugin, view) => (plugin === "rehearse" ? layouts[view] : undefined),
    (plugin, name) => (plugin === "rehearse" ? surfaces.find((s) => s.name === name) : undefined),
    makeSurfaces(log, "main"),
    makePrompts(log),
    (plugin) => (plugin === "rehearse" ? surfaces : []),
  )
  const panels = () => ((log.all().filter((e) => e.type === "ACTIVITY_SNAPSHOT" && e.activityType === PANELS).at(-1)?.content ?? { panels: [] }) as { panels: ReadonlyArray<{ id: string }> }).panels.map((p) => p.id)
  return { log, on, panels }
}
const status: Surface = { kind: "panel", name: "status", view: "status", scope: "shell", edge: "bottom", size: 1, input: "none" }

test("an open outside any developer call is refused for a tile; a panel opens any time", async () => {
  const { on, log, panels } = await surfaceSetup([{ kind: "tile", name: "main", view: "tester" }, status])
  on("rehearse", { event: "start", id: "t1", title: "tester", task: "t", view: "tester" })
  expect(() => on("rehearse", { event: "open", surfaces: [{ surface: "main", agent: "t1" }], gesture: false })).toThrow(/opens only while you handle the developer's call/)
  expect(() => on("rehearse", { event: "open", surfaces: [{ surface: "nope", agent: "t1" }], gesture: true })).toThrow(/declares no surface nope/)
  on("rehearse", { event: "open", surfaces: [{ surface: "status", agent: "t1" }], gesture: false })
  expect(panels()).toEqual(["rehearse:status:rehearse:t1"])
  on("rehearse", { event: "open", surfaces: [{ surface: "main", agent: "t1" }], gesture: true })
  expect(log.all().at(-1)).toMatchObject({ type: "CUSTOM", name: NAVIGATE, value: { kind: "tile", view: "rehearse:t1" } })
})

test("an agent's end closes its panels and withdraws its popovers", async () => {
  const { on, log, panels } = await surfaceSetup([{ kind: "popover", name: "ask", view: "tester" }, status])
  on("rehearse", { event: "start", id: "t1", title: "tester", task: "t", view: "tester" })
  on("rehearse", { event: "open", surfaces: [{ surface: "status", agent: "t1" }, { surface: "ask", agent: "t1" }], gesture: true })
  await Bun.sleep(10)
  const asked = log.all().find((e) => e.type === "CUSTOM" && e.name === PROMPT)!.value as { id: string; kind: string; view: string; options: unknown[] }
  expect(asked).toMatchObject({ kind: "surface", view: "rehearse:t1", options: [] })
  expect(panels()).toEqual(["rehearse:status:rehearse:t1"])
  on("rehearse", { event: "end", id: "t1", ok: true })
  await Bun.sleep(10)
  expect(panels()).toEqual([])
  expect(log.all().some((e) => e.type === "CUSTOM" && e.name === PROMPT_DONE && (e.value as { id: string }).id === asked.id)).toBe(true)
})

test("a view other than the one the agent started with keeps its own data", async () => {
  const { on, log } = await surfaceSetup([status])
  on("rehearse", { event: "start", id: "t1", title: "tester", task: "t", view: "tester" })
  on("rehearse", { event: "set", id: "t1", view: "status", section: "line", data: { items: [{ label: "stories", value: "1/3" }] } })
  on("rehearse", { event: "set", id: "t1", view: "tester", section: "progress", data: { items: [] } })
  const views = threadViews(log, "main")
  expect(views.data("rehearse:t1@status", "line")).toEqual({ items: [{ label: "stories", value: "1/3" }] })
  expect(views.data("rehearse:t1", "line")).toBeUndefined()
  expect(views.data("rehearse:t1", "progress")).toEqual({ items: [] })
})

test("surfaces open only for agents the plugin started, and one popover per plugin at a time", async () => {
  const { on } = await surfaceSetup([{ kind: "popover", name: "ask", view: "tester" }, status])
  expect(() => on("rehearse", { event: "open", surfaces: [{ surface: "status", agent: "ghost" }], gesture: true })).toThrow(/has not started an agent ghost/)
  on("rehearse", { event: "start", id: "t1", title: "tester", task: "t", view: "tester" })
  on("rehearse", { event: "start", id: "t2", title: "tester", task: "t", view: "tester" })
  on("rehearse", { event: "open", surfaces: [{ surface: "ask", agent: "t1" }], gesture: true })
  expect(() => on("rehearse", { event: "open", surfaces: [{ surface: "ask", agent: "t2" }], gesture: true })).toThrow(/already has a popover up/)
})

test("a restarted agent starts its other views afresh too (no last run's numbers in its panel)", async () => {
  const { on, log } = await surfaceSetup([status])
  on("rehearse", { event: "start", id: "run", title: "rehearse", task: "t", view: "tester" })
  on("rehearse", { event: "set", id: "run", view: "status", section: "line", data: { items: [{ label: "rehearse", value: "40/40 steps" }] } })
  on("rehearse", { event: "start", id: "run", title: "rehearse", task: "t2", view: "tester" })
  expect(threadViews(log, "main").data("rehearse:run@status", "line")).toBeUndefined()
})

test("a multi-surface open is all or nothing", async () => {
  const { on, panels } = await surfaceSetup([status])
  on("rehearse", { event: "start", id: "t1", title: "tester", task: "t", view: "tester" })
  expect(() => on("rehearse", { event: "open", surfaces: [{ surface: "status", agent: "t1" }, { surface: "nope", agent: "t1" }], gesture: true })).toThrow(/nope/)
  expect(panels()).toEqual([])
})

test("an agent that starts with a view the plugin has a card for carries the card in its layout", async () => {
  const { on, log } = await surfaceSetup([{ kind: "card", name: "tester", view: "tester", headline: "progress" }])
  on("rehearse", { event: "start", id: "t1", title: "tester", task: "t", view: "tester" })
  expect(threadViews(log, "main").layout("rehearse:t1")?.card).toEqual({ headline: "progress" })
  on("rehearse", { event: "start", id: "t2", title: "tester", task: "t" })
  expect(threadViews(log, "main").layout("rehearse:t2")?.card).toBeUndefined()
})

test("a view kept from an earlier core whose plugin now declares a different layout starts again with the new one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zarg-pa-"))
  const log = await Effect.runPromise(makeLog(dir, (t) => t))
  const before = layoutOf(defineView("journeys", { list: { kind: "table", role: "primary", columns: [{ id: "name", label: "journey" }] }, flow: { kind: "text", role: "pinned" } }))
  const after = layoutOf(defineView("journeys", { list: { kind: "table", role: "primary", columns: [{ id: "name", label: "journey" }] }, flow: { kind: "text", role: "pinned", follows: "list" } }))
  pluginAgents(log, "main", () => before)("gherkin", { event: "set", id: "journeys", view: "journeys", section: "flow", data: { markdown: "old" } })
  threadViews(log, "main").flush()
  // A new core, the plugin updated: the next push starts the view afresh with the layout it declares now.
  const log2 = await Effect.runPromise(makeLog(dir, (t) => t))
  pluginAgents(log2, "main", () => after)("gherkin", { event: "set", id: "journeys", view: "journeys", section: "flow", data: { markdown: "none", rows: { "J-1": "one" } } })
  const views = threadViews(log2, "main")
  views.flush()
  expect(views.layout("gherkin:journeys@journeys")).toEqual(after)
})

test("the same layout with its keys in another order is the same: pushes keep each other's data", async () => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-pa-")), (t) => t))
  const a = layoutOf(defineView("journeys", { list: { kind: "table", role: "primary", columns: [{ id: "name", label: "journey" }] }, flow: { kind: "text", role: "pinned", follows: "list" } }))
  // The same layout, its keys written in another order (as a replayed or decoded copy may have them).
  const reorder = (v: unknown): unknown => (Array.isArray(v) ? v.map(reorder) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v)
  let calls = 0
  const on = pluginAgents(log, "main", () => (calls++ === 0 ? a : (reorder(a) as typeof a)))
  on("gherkin", { event: "set", id: "journeys", view: "journeys", section: "list", data: { rows: [{ id: "J-1", cells: { name: "a" } }] } })
  on("gherkin", { event: "set", id: "journeys", view: "journeys", section: "flow", data: { markdown: "x" } })
  const views = threadViews(log, "main")
  views.flush()
  expect(log.all().filter((e) => (e as { type?: string; activityType?: string }).type === "ACTIVITY_SNAPSHOT" && (e as { activityType?: string }).activityType === "zarg.view").length).toBe(1)
})
