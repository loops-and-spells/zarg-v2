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
