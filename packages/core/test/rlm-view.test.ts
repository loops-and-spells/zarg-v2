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
    expect(rlmLines({ type: "call", service: "Graph", method: "show", params: { id: "C-1" }, ms: 4, ok: false, failure: { _tag: "NotFound", message: "no C-1" } })).toEqual([
      { text: '  Graph.show {"id":"C-1"}  4ms  failed: NotFound: no C-1', tone: "error" },
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

  test("an agent's history: the task, each turn's model time, calls, and cells with code and output", () => {
    const lines = [
      { type: "start", rlm: "rlm-2", preset: "research", task: "Find the VM grid\nmore context" },
      { type: "model", rlm: "rlm-2", turn: 1, modelMs: 2300, promptTokens: 4206, completionTokens: 83 },
      { type: "call", rlm: "rlm-2", turn: 1, service: "Graph", method: "show", params: { id: "S-1" }, ok: true, result: {}, ms: 11 },
      { type: "call", rlm: "rlm-2", turn: 1, service: "Fs", method: "read", params: { path: "x" }, ok: false, failure: { _tag: "NotFound", message: "no x" }, ms: 2 },
      { type: "tick", rlm: "rlm-2", turn: 1, source: "clock", value: 1 },
      { type: "step", rlm: "rlm-2", turn: 1, text: "Looking.", cells: [{ code: "const a = 1\nreturn a", ok: true, output: "1", ms: 40 }] },
      { type: "extend", rlm: "rlm-2", extended: false, turns: 15, confidence: 0.7, reason: "repeated calls 6/6" },
    ].flatMap(rlmLines)
    expect(lines.map((l) => l.text)).toEqual([
      "research rlm-2: Find the VM grid",
      "turn 1 · model 2.3s · 4,206 → 83 tokens",
      '  Graph.show {"id":"S-1"}  11ms',
      '  Fs.read {"path":"x"}  2ms  failed: NotFound: no x',
      "  Looking.",
      "  cell ok 40ms",
      "    │ const a = 1",
      "    │ return a",
      "    → 1",
      "told to wrap up  0.70  repeated calls 6/6",
    ])
    expect(lines.find((l) => l.text.includes("failed"))?.tone).toBe("error")
  })

  test("a secret in a call's params never reaches the view, even where a line is clipped or JSON-escaped", async () => {
    const secret = `tok_${"x".repeat(150)}"quoted`
    const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-rlmv-")), (t) => t.replaceAll(secret, "<redacted>")))
    const views = makeViews(log, "main", { delayMs: 1 })
    const a = makeActivity(log, "main", undefined, views)
    a.observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "t", scope: {}, depth: 0, budget: { turns: 5, tokens: 0, wallMs: 0 } } as never)
    a.observe({ type: "record", id: "rlm-1", turn: 1, record: { kind: "call", service: "Sh", method: "run", params: { cmd: `curl -H ${secret}` }, ok: true, ms: 3 } } as never)
    views.flush()
    expect(JSON.stringify(log.all())).not.toContain("tok_xxxxxxxxxx")
  })

  test("the task section is clipped: a huge cell does not travel whole on every step", async () => {
    const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-rlmv-")), (t) => t))
    const views = makeViews(log, "main", { delayMs: 1 })
    const a = makeActivity(log, "main", undefined, views)
    a.observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "t".repeat(10_000), scope: {}, depth: 0, budget: { turns: 5, tokens: 0, wallMs: 0 } } as never)
    a.observe({ type: "step", id: "rlm-1", turn: 1, text: "", cells: [{ code: "x".repeat(50_000), ok: true, output: "", ms: 1 }] } as never)
    views.flush()
    const tasks = log.all().flatMap((e) => ((e as { patch?: ReadonlyArray<{ path: string; value: { markdown: string } }> }).patch ?? []).filter((p) => p.path === "/data/task"))
    for (const t of tasks) expect(t.value.markdown.length).toBeLessThanOrEqual(8_000)
  })
})
