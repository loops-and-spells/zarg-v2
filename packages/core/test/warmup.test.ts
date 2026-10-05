import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelError } from "@zarg/model"
import { makeWarmup } from "../src/warmup"

const models = (state: string) => [{ id: "big", contextLength: 0, maxOutputTokens: undefined, supportsTools: true, reasoningEfforts: [], capabilities: [], state }]
const deps = (o: { state: string; warm: Effect.Effect<void, ModelError> }) => {
  const events: Array<Record<string, unknown>> = []
  const failed: Array<string> = []
  const w = makeWarmup({
    driver: () => "router:big",
    model: { list: () => Effect.succeed(models(o.state)), warm: () => o.warm } as never,
    agentEvents: (_p, e) => void events.push(e as Record<string, unknown>),
    onFailed: (reason) => Effect.sync(() => void failed.push(reason)),
    tickMs: 10,
  })
  return { w, events, failed }
}

// @scenario S-0037
test("a cold driver model warms up: a warm-up agent shows its progress, and ready waits for it", async () => {
  const { w, events } = deps({ state: "cold", warm: Effect.sleep("60 millis") })
  const ok = await Effect.runPromise(w.ensure)
  expect(ok).toBe(true)
  expect(events.find((e) => e.event === "start")).toMatchObject({ id: "warmup", title: "warming router:big" })
  expect(events.some((e) => e.event === "status" && String((e as { text?: string }).text).startsWith("warming router:big ·"))).toBe(true)
  expect(events.at(-1)).toMatchObject({ event: "end", id: "warmup", ok: true })
  expect(await Effect.runPromise(w.ready)).toBe(true)
})

test("a model already running needs no warm-up: no agent, ready at once", async () => {
  const { w, events } = deps({ state: "running", warm: Effect.die("never") })
  expect(await Effect.runPromise(w.ensure)).toBe(true)
  expect(events).toEqual([])
})

// @scenario S-0039
test("a model that fails to start: the agent ends failed with the reason, setup is told why", async () => {
  const { w, events, failed } = deps({ state: "cold", warm: Effect.fail(new ModelError({ kind: "status", status: 500, message: "500 out of memory" })) })
  expect(await Effect.runPromise(w.ensure)).toBe(false)
  expect(events.at(-1)).toMatchObject({ event: "end", id: "warmup", ok: false, message: "router:big did not start: 500 out of memory" })
  expect(failed).toEqual(["router:big did not start: 500 out of memory"])
})
