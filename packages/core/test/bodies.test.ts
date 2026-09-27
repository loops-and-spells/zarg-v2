import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeBodies } from "../src/bodies"
import { makeLog } from "../src/log"

const setup = async () => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-bodies-")), (t) => t))
  await Effect.runPromise(log.transcript("main", { type: "start", rlm: "rlm-1", task: "t" }))
  await Effect.runPromise(log.transcript("main", { type: "start", rlm: "rehearse:tester-1", task: "The developer" }))
  await Effect.runPromise(log.transcript("main", { type: "step", rlm: "rehearse:tester-1", text: "UX-1: feel 1.80" }))
  const calls: Array<[string, string, unknown]> = []
  const invoke = (plugin: string, method: string, params: unknown) =>
    Effect.suspend((): Effect.Effect<unknown, { readonly _tag: string; readonly message: string }> => {
      calls.push([plugin, method, params])
      if (plugin !== "rehearse") return Effect.fail({ _tag: "NotLoaded", message: `plugin ${plugin} is not loaded` })
      if (method === "body") return Effect.succeed({ parts: [{ kind: "history" }, { kind: "tabs", tabs: [{ title: "Feedback", columns: ["id"], rows: [{ id: "R-1", cells: ["R-1"] }] }], actions: [{ id: "apply", label: "Apply", key: "a" }] }] })
      return Effect.succeed({ notice: "1 finding sent to the driver" })
    })
  return { bodies: makeBodies({ log, invoke }), calls }
}

test("an RLM's body is its history", async () => {
  const { bodies } = await setup()
  const b = await Effect.runPromise(bodies.body("main", "rlm-1"))
  expect(b).toMatchObject({ parts: [{ kind: "history", lines: [{ type: "start", rlm: "rlm-1" }] }] })
})

test("a plugin agent's body comes from its plugin, with its history filled in by the core", async () => {
  const { bodies, calls } = await setup()
  const b = (await Effect.runPromise(bodies.body("main", "rehearse:tester-1"))) as { parts: ReadonlyArray<{ kind: string; lines?: ReadonlyArray<{ type: string }> }> }
  expect(calls[0]).toEqual(["rehearse", "body", { agent: "tester-1" }])
  expect(b.parts.map((p) => p.kind)).toEqual(["history", "tabs"])
  expect(b.parts[0]!.lines!.map((l) => l.type)).toEqual(["start", "step"])
})

test("an action goes to the plugin with the selected rows; an action on a gone plugin's agent is a notice", async () => {
  const { bodies, calls } = await setup()
  expect(await Effect.runPromise(bodies.act("main", "rehearse:tester-1", "apply", ["R-1"]))).toEqual({ notice: "1 finding sent to the driver" })
  expect(calls.at(-1)).toEqual(["rehearse", "act", { agent: "tester-1", action: "apply", rows: ["R-1"] }])
  expect(await Effect.runPromise(bodies.act("main", "gone:t-1", "apply", ["x"]))).toEqual({ notice: "plugin gone is not loaded" })
  expect(await Effect.runPromise(bodies.body("main", "gone:t-1"))).toBeUndefined()
})
