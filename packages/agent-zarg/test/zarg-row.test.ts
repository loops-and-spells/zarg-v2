import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import { initial, reduce } from "@zarg/client"
import { makeLog, type WireEvent } from "@zarg/core"
import type { Asker, Rlm } from "@zarg/rlm"
import { makeThread } from "../src/thread"

const question = { question: "Which card first?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }

test("zarg is a row at the root of main, its driver RLM under it; it asks for attention while its question waits", async () => {
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-row-")), (t) => t)
      const driver = (_s: Rlm.RlmSpec, asker: Asker, observe: (e: Rlm.RlmEvent) => void) =>
        Effect.gen(function* () {
          observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "t", scope: {}, depth: 0, budget: { turns: 25, tokens: 0, wallMs: 0 } } as never)
          const a = yield* asker.ask(question)
          return { id: "rlm-1", value: a.choice, turns: 1, tokens: 1 }
        }) as never
      const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed([]), driver })
      const state = () => log.all().filter((e) => e.threadId === "main").reduce(reduce, initial("main"))
      const first = [...(yield* Stream.runCollect(thread.run({ runId: "r1" })))] as ReadonlyArray<WireEvent>
      const asking = state().rlms
      const id = (first.at(-1) as unknown as { outcome: { interrupts: ReadonlyArray<{ id: string }> } }).outcome.interrupts[0]!.id
      yield* Stream.runCollect(thread.run({ runId: "r2", resume: [{ interruptId: id, payload: { choice: "a" } }] }))
      yield* thread.stop
      return { asking, after: state().rlms }
    }),
  )
  expect(out.asking.zarg).toMatchObject({ preset: "zarg", parent: null, attention: { reason: "asks: Which card first?" } })
  expect(out.asking["rlm-1"]!.parent).toBe("zarg")
  expect(out.after.zarg!.attention).toBeUndefined()
})
