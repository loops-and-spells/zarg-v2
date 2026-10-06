import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Decisions } from "@zarg/decisions"
import { stubLayer } from "../src/stub"

const file = (body: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), "zt-stub-")), "cells.json")
  writeFileSync(f, JSON.stringify(body))
  return f
}
const decide = (f: string) =>
  Effect.runPromise(Effect.flip(Effect.flatMap(Decisions, (d) => d.decide({ state: "s", questions: { single: { type: "noul", instructions: "?" }, progressing: { type: "noul", instructions: "?" } } }))).pipe(Effect.provide(stubLayer(f)), Effect.orElseSucceed(() => undefined as never)))

test("stub decisions: unavailable unless scripted; scripted, each yes/no question answers with the confidence given (the ones named no, no)", async () => {
  expect(await decide(file({ cells: [] }))).toMatchObject({ kind: "unavailable" })
  const answers = await Effect.runPromise(Effect.flatMap(Decisions, (d) => d.decide({ state: "s", questions: { single: { type: "noul", instructions: "?" }, progressing: { type: "noul", instructions: "?" } } })).pipe(Effect.provide(stubLayer(file({ cells: [], decisions: { confidence: 0.83, no: ["progressing"] } })))))
  expect(answers).toEqual({ single: { type: "noul", answer: true, probability: 0.83, confidence: 0.83 }, progressing: { type: "noul", answer: false, probability: 0.17, confidence: 0.83 } })
})

test("stub routes: a request whose messages hold a route's words runs that route's cells (each its own count); others the default cells", async () => {
  const { Model } = await import("@zarg/model")
  const { Stream } = await import("effect")
  const f = file({ cells: ["default"], routes: [{ when: "Write the implementation plan for scenario S-0002", cells: ["plan-1", "plan-2"] }] })
  const layer = stubLayer(f)
  const seq = (task: string) =>
    Effect.flatMap(Model.Model, (m) => Stream.runCollect(m.stream({ model: "stub:scripted" as never, messages: [{ role: "user", content: task }] }))).pipe(
      Effect.map((events) => JSON.parse(([...events][0] as { call: { function: { arguments: string } } }).call.function.arguments).code as string),
    )
  const out = await Effect.runPromise(Effect.all([seq("Write the implementation plan for scenario S-0002:\n…"), seq("anything else"), seq("Write the implementation plan for scenario S-0002:"), seq("Write the implementation plan for scenario S-0002:")]).pipe(Effect.provide(layer)))
  expect(out).toEqual(["plan-1", "default", "plan-2", "plan-2"])
})
