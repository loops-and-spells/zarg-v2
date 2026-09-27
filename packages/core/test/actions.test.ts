import { expect, test } from "bun:test"
import { Effect } from "effect"
import { makeActions } from "../src/actions"

const setup = () => {
  const calls: Array<[string, string, unknown]> = []
  const invoke = (plugin: string, method: string, params: unknown) =>
    Effect.suspend((): Effect.Effect<unknown, { readonly _tag: string; readonly message: string }> => {
      calls.push([plugin, method, params])
      if (plugin !== "rehearse") return Effect.fail({ _tag: "NotLoaded", message: `plugin ${plugin} is not loaded` })
      return Effect.succeed({ notice: "1 finding sent to the driver" })
    })
  const applied: Array<[string, ReadonlyArray<string>]> = []
  return { actions: makeActions({ invoke, onApply: (plugin, rows) => void applied.push([plugin, rows]) }), calls, applied }
}

test("an action goes to the plugin with its section and rows; an action on a gone plugin's agent is a notice", async () => {
  const { actions, calls, applied } = setup()
  expect(await Effect.runPromise(actions.act("main", "rehearse:tester-1", "apply", "review.findings", ["R-1"]))).toEqual({ notice: "1 finding sent to the driver" })
  expect(calls.at(-1)).toEqual(["rehearse", "act", { agent: "tester-1", action: "apply", section: "review.findings", rows: ["R-1"] }])
  // The core keeps the developer's choice itself: the findings gate trusts it, not the plugin's word.
  expect(applied).toEqual([["rehearse", ["R-1"]]])
  expect(await Effect.runPromise(actions.act("main", "gone:t-1", "apply", undefined, ["x"]))).toEqual({ notice: "plugin gone is not loaded" })
  expect(await Effect.runPromise(actions.act("main", "rlm-1", "apply", undefined, ["x"]))).toEqual({ notice: "rlm-1 has no actions" })
})

test("the developer's answer and message to a plugin agent reach its conversation", async () => {
  const { actions, calls } = setup()
  expect(await Effect.runPromise(actions.answer("main", "rehearse:tester-1", "q1", { choice: "y" }))).toEqual({ notice: "1 finding sent to the driver" })
  expect(calls.at(-1)).toEqual(["rehearse", "$answer", { agent: "tester-1", question: "q1", answer: { choice: "y" } }])
  await Effect.runPromise(actions.message("main", "rehearse:tester-1", "hi"))
  expect(calls.at(-1)).toEqual(["rehearse", "$message", { agent: "tester-1", text: "hi" }])
  expect(await Effect.runPromise(actions.message("main", "rlm-1", "hi"))).toEqual({ notice: "rlm-1 has no conversation of its own" })
})

test("an answer the agent no longer waits for is withdrawn from its view, its messages kept", async () => {
  const withdrawn: Array<[string, string]> = []
  const actions = makeActions({
    invoke: () => Effect.succeed({ notice: "that question is no longer open", withdrawn: true }),
    withdraw: (thread, agent) => void withdrawn.push([thread, agent]),
  })
  expect(await Effect.runPromise(actions.answer("main", "p:a-1", "q1", { choice: "y" }))).toEqual({ notice: "that question is no longer open" })
  expect(withdrawn).toEqual([["main", "p:a-1"]])
})
