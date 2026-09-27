import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeLog } from "../src/log"
import { makeYolo } from "../src/plugins"

describe("YOLO control", () => {
  test("turning YOLO on or off tells every client on main, and answers whether any plugin is in YOLO", async () => {
    const out = await Effect.runPromise(Effect.gen(function* () {
      const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zt-yolo-")), (t) => t)
      const state = { all: false, plugins: new Set<string>() }
      const control = {
        on: (p: string) => state.all || state.plugins.has(p),
        set: (on: boolean, p?: string) => void (p === undefined ? (state.all = on) : on ? state.plugins.add(p) : state.plugins.delete(p)),
        any: () => state.all || state.plugins.size > 0,
      }
      const yolo = makeYolo(log, control)
      const a = yield* yolo.set(true)
      const b = yield* yolo.set(false)
      const c = yield* yolo.set(true, "tracker")
      return { answers: [a, b, c], events: log.all().filter((e) => e.type === "CUSTOM").map((e) => ({ thread: e.threadId, name: (e as any).name, value: (e as any).value })) }
    }))
    expect(out.answers).toEqual([{ on: true }, { on: false }, { on: true }])
    expect(out.events).toEqual([
      { thread: "main", name: "zarg.yolo", value: { on: true } },
      { thread: "main", name: "zarg.yolo", value: { on: false } },
      { thread: "main", name: "zarg.yolo", value: { on: true } },
    ])
  })
})
