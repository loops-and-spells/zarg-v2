import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Kernel, type Recorded } from "../src"
import { notes } from "./fixtures"

test("every service call a cell makes is recorded with its params, result and time, failures too", async () => {
  const records: Array<Recorded> = []
  const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const n = notes()
    const k = yield* Kernel.make({ services: [n.bound], record: (r) => records.push(r) })
    return yield* k.run(`const a = yield* Notes.add({ text: "hi" })\nconst b = yield* Effect.catch(Notes.get({ id: "nope" }), () => Effect.succeed("missing"))\nreturn [a.id, b]`)
  })))
  expect(out.ok).toBe(true)
  const calls = records.filter((r) => r.kind === "call")
  expect(calls.map((c: any) => [c.service, c.method, c.params, c.ok, c.result ?? c.failure])).toEqual([
    ["Notes", "add", { text: "hi" }, true, { id: "n1" }],
    ["Notes", "get", { id: "nope" }, false, { _tag: "NotFound", message: "no note nope" }],
  ])
  expect(calls.every((c: any) => typeof c.ms === "number" && c.cell === 1)).toBe(true)
})
