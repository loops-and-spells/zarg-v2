import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeLog } from "../src/log"
import { forDriver, makeYolo, yoloState } from "../src/plugins"

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

  test("turning YOLO on loads plugins waiting on their grant; turning it off does not", async () => {
    const loads: Array<string> = []
    await Effect.runPromise(Effect.gen(function* () {
      const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zt-yolo-")), (t) => t)
      const on = { v: false }
      const yolo = makeYolo(log, { on: () => on.v, set: (v) => void (on.v = v), any: () => on.v }, Effect.sync(() => void loads.push("load")))
      yield* yolo.set(true, "rehearse")
      yield* yolo.set(false)
    }))
    // The load runs detached (a question may wait on the developer): let it run.
    await Bun.sleep(5)
    expect(loads).toEqual(["load"])
  })

  test("the driver never gets the host's plugin items: only the developer can act on them", () => {
    const item = (id: string) => ({ id, title: id, detail: "", about: [], priority: 1 })
    expect(forDriver([item("plugin-grant:rehearse"), item("gherkin:dead-end:S-1"), item("plugin-failed:x"), item("plugin-disabled:y"), item("plugin-needs:a:b")]).map((i) => i.id)).toEqual(["gherkin:dead-end:S-1"])
  })

  test("a starting core says its own YOLO state, so a replayed 'on' from an earlier core is not what clients show", async () => {
    const events = await Effect.runPromise(Effect.gen(function* () {
      const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zt-yolo-")), (t) => t)
      yield* log.append("main", { type: "CUSTOM", name: "zarg.yolo", value: { on: true } } as never)
      const yolo = makeYolo(log, { on: () => false, set: () => {}, any: () => false })
      yield* yolo.announce
      return log.all().filter((e) => (e as { name?: string }).name === "zarg.yolo").map((e) => (e as unknown as { value: unknown }).value)
    }))
    expect(events).toEqual([{ on: true }, { on: false }])
  })

  test("YOLO is kept per project across restarts, in the user folder; /yolo off clears it", () => {
    const user = mkdtempSync(join(tmpdir(), "zt-yolo-user-"))
    const first = yoloState(user, "/p/one", false)
    first.set(true)
    first.set(true, "rehearse")
    const again = yoloState(user, "/p/one", false)
    expect(again.on("anything")).toBe(true)
    // Another project is not affected; --yolo turns it on for one run without saving.
    expect(yoloState(user, "/p/two", false).any()).toBe(false)
    expect(yoloState(user, "/p/two", true).any()).toBe(true)
    expect(yoloState(user, "/p/two", false).any()).toBe(false)
    again.set(false)
    expect(yoloState(user, "/p/one", false).any()).toBe(false)
    const one = yoloState(user, "/p/one", false)
    one.set(true, "rehearse")
    expect(yoloState(user, "/p/one", false).on("rehearse")).toBe(true)
    expect(yoloState(user, "/p/one", false).on("other")).toBe(false)
  })
})
