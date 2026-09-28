import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineView, layoutOf } from "@zarg/view"
import { makeLog } from "../src/log"
import { pluginAgents, withLabels } from "../src/plugin-agents"
import { threadViews } from "../src/views"

const layout = { name: "t", sections: [{ id: "list", kind: "table", role: "primary", columns: [{ id: "card", label: "card", ref: true }, { id: "note", label: "note" }] }] } as never
const many = (refs: ReadonlyArray<string>) => Effect.succeed({ entities: refs.filter((r) => r.startsWith("gherkin/")).map((r) => ({ ref: r, type: "gherkin/card", id: r.split(":")[1]!, version: "v", data: {}, label: { text: `${r.split(":")[1]} Title`, tone: "card", glyph: "◇" } })), failed: [] })

describe("labels for refs in view data", () => {
  test("ref columns get labels; other columns and unknown refs do not", async () => {
    const out = (await Effect.runPromise(withLabels(layout, "list", { rows: [{ id: "a", cells: { card: "gherkin/card:UX-0001", note: "gherkin/card:UX-0002" } }, { id: "b", cells: { card: "nope/x:1", note: "" } }] }, many))) as { labels: Record<string, unknown> }
    expect(Object.keys(out.labels)).toEqual(["gherkin/card:UX-0001"])
  })
  test("data without ref columns passes through untouched", async () => {
    const data = { rows: [] }
    expect(await Effect.runPromise(withLabels(layout, "other", data, many))).toBe(data)
  })
})

test("two quick sets keep their order", async () => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-refs-")), (t) => t))
  const t = layoutOf(defineView("t", { list: { kind: "table", role: "primary", columns: [{ id: "card", label: "card", ref: true }] } }))
  let calls = 0
  // The first lookup is slow, the second instant: without ordering, the first set would land last.
  const many = () => Effect.as(Effect.sleep(calls++ === 0 ? 30 : 0), { entities: [], failed: [] })
  const on = pluginAgents(log, "main", () => t, undefined, undefined, undefined, undefined, many)
  on("p", { event: "start", id: "a", title: "a", task: "a", view: "t" })
  on("p", { event: "set", id: "a", section: "list", data: { rows: [{ id: "1", cells: { card: "x/y:A" } }] } })
  on("p", { event: "set", id: "a", section: "list", data: { rows: [{ id: "2", cells: { card: "x/y:B" } }] } })
  await Bun.sleep(80)
  threadViews(log, "main").flush()
  const patches = log.all().filter((e) => (e as { activityType?: string }).activityType === "zarg.view").flatMap((e) => ((e as { patch?: Array<{ path: string; value: { rows: Array<{ id: string }> } }> }).patch ?? []))
  expect(patches.filter((p) => p.path === "/data/list").at(-1)!.value.rows[0]!.id).toBe("2")
})
