import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeActivity } from "../src/activity"
import { makeLog } from "../src/log"
import { RLM_LAYOUT, rlmLines } from "../src/rlm-view"
import { makeViews } from "../src/views"

describe("the RLM's view", () => {
  test("history lines read as the history view did: model turns, calls, cells", () => {
    expect(rlmLines({ type: "model", turn: 2, modelMs: 1500, promptTokens: 1200, completionTokens: 80 })).toEqual([{ text: "turn 2 · model 1.5s · 1,200 → 80 tokens", tone: "accent" }])
    expect(rlmLines({ type: "call", service: "Graph", method: "show", params: { id: "UX-1" }, ms: 4, ok: false, failure: { _tag: "NotFound", message: "no UX-1" } })).toEqual([
      { text: '  Graph.show {"id":"UX-1"}  4ms  failed: NotFound: no UX-1', tone: "error" },
    ])
    expect(rlmLines({ type: "step", text: "", cells: [{ code: "yield* x", ok: true, output: "", ms: 3 }] })).toEqual([
      { text: "  cell ok 3ms", tone: "dim" },
      { text: "    │ yield* x", tone: "dim" },
    ])
  })

  test("an RLM run fills its view: status, task with the current cell, history", async () => {
    const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-rlmv-")), (t) => t))
    const views = makeViews(log, "main", { delayMs: 1 })
    const a = makeActivity(log, "main", undefined, views)
    a.observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "Fix S-1", scope: {}, depth: 0, budget: { turns: 25, tokens: 0, wallMs: 0 } } as never)
    a.observe({ type: "step", id: "rlm-1", turn: 1, text: "looking", cells: [{ code: "yield* Graph.show({ id: \"S-1\" })", ok: true, output: "ok", ms: 5 }] } as never)
    a.observe({ type: "turn", id: "rlm-1", turn: 1, tokens: 900 } as never)
    views.flush()
    expect(views.layout("rlm-1")).toEqual(RLM_LAYOUT)
    const events = log.all().filter((e) => (e as { activityType?: string }).activityType === "zarg.view") as ReadonlyArray<Record<string, any>>
    const patch = events.flatMap((e) => e.patch ?? [])
    expect(patch.findLast((p: { path: string }) => p.path === "/data/task").value.markdown).toContain('yield* Graph.show({ id: "S-1" })')
    expect(patch.filter((p: { path: string }) => p.path === "/data/history/lines/-").map((p: { value: { text: string } }) => p.value.text)).toContain("  looking")
    expect(patch.findLast((p: { path: string }) => p.path === "/data/status").value.items).toContainEqual({ label: "turns", value: "1/25" })
  })
})
