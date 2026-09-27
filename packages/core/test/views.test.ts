import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { defineView, layoutOf, LOG_KEEP } from "@zarg/view"
import { makeLog } from "../src/log"
import { makeViews } from "../src/views"

const layout = layoutOf(defineView("tester", { progress: { kind: "stats", role: "summary" }, steps: { kind: "log", role: "log" } }))
const setup = async (redact: (t: string) => string = (t) => t) => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-views-")), redact))
  const views = makeViews(log, "main", { delayMs: 20 })
  const events = () => log.all().filter((e) => (e as { activityType?: string }).activityType === "zarg.view")
  return { log, views, events }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("the ViewStore", () => {
  test("start sends the layout as a snapshot; a set goes out as a replace delta", async () => {
    const { views, events } = await setup()
    views.start("rehearse:tester-1", layout)
    views.set("rehearse:tester-1", "progress", { items: [{ label: "steps", value: "1/2" }] })
    await sleep(40)
    const [snap, delta] = events() as ReadonlyArray<Record<string, any>>
    expect(snap).toMatchObject({ type: "ACTIVITY_SNAPSHOT", messageId: "main:view:rehearse:tester-1", content: { agent: "rehearse:tester-1", layout, data: {} } })
    expect(delta).toMatchObject({ type: "ACTIVITY_DELTA", patch: [{ op: "replace", path: "/data/progress", value: { items: [{ label: "steps", value: "1/2" }] } }] })
  })

  test("a push that does not fit its section is refused, and nothing is sent", async () => {
    const { views, events } = await setup()
    views.start("a", layout)
    expect(() => views.set("a", "progress", { rows: [] })).toThrow(/progress/)
    expect(() => views.append("a", "progress", [{ text: "x" }])).toThrow(/not a log/)
    expect(() => views.set("nobody", "progress", { items: [] })).toThrow(/no view/)
    await sleep(40)
    expect(events()).toHaveLength(1)
  })

  test("a log keeps its last 2000 lines and pushes within the window go out as one delta", async () => {
    const { views, events } = await setup()
    views.start("a", layout)
    for (let i = 0; i < LOG_KEEP + 10; i++) views.append("a", "steps", [{ text: String(i) }])
    views.set("a", "progress", { items: [] })
    await sleep(40)
    const deltas = events().filter((e) => e.type === "ACTIVITY_DELTA")
    expect(deltas).toHaveLength(1)
    // The delta carries only what the view keeps: the last LOG_KEEP lines, then the set.
    const patch = (deltas[0] as unknown as { patch: ReadonlyArray<{ op: string; path: string; value: { text?: string } }> }).patch
    expect(patch.filter((p) => p.path === "/data/steps/lines/-")).toHaveLength(LOG_KEEP)
    expect(patch[0]!.value.text).toBe("10")
  })

  test("pushed text is redacted before it is stored or sent", async () => {
    const { views, events } = await setup((t) => t.replaceAll("s3cr3t-view-test", "<redacted>"))
    views.start("a", layout)
    views.append("a", "steps", [{ text: "key s3cr3t-view-test" }])
    await sleep(40)
    expect(JSON.stringify(events())).not.toContain("s3cr3t-view-test")
  })

  test("a batched write after the thread's log is gone (the core shut down) is dropped, never thrown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zarg-views-"))
    const log = await Effect.runPromise(makeLog(dir, (t) => t))
    const views = makeViews(log, "main", { delayMs: 20 })
    views.start("a", layout)
    rmSync(dir, { recursive: true, force: true })
    views.append("a", "steps", [{ text: "late" }])
    expect(() => views.flush()).not.toThrow()
  })
})
