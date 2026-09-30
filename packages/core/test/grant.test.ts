import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { grantAsk, threadOfTopic } from "../src/grant"
import { setup } from "./inbox-helper"

test("a grant question is a blocking grant topic; its answer is the grant's choice; a restart makes it moot", async () => {
  const { inbox, d } = await setup()
  const ask = grantAsk(inbox)
  const f = Effect.runFork(ask("tracker", { question: "Plugin tracker wants to reach a.test.", options: [{ id: "once", label: "Allow once", recommended: true }, { id: "deny", label: "Deny" }], allowOther: false, kind: "grant" }))
  await Bun.sleep(5)
  const t = inbox.list()[0]!
  // The core's words: raised as zarg's (the plugin cannot rewrite them), naming the plugin that asks.
  expect(t).toMatchObject({ kind: "grant", blocking: true, from: { plugin: "zarg", agent: "tracker" }, title: "Plugin tracker wants to reach a.test.", answers: [{ id: "once", label: "Allow once", recommended: true }, { id: "deny", label: "Deny" }] })
  await Effect.runPromise(inbox.answer(t.id, { answer: "deny" }))
  expect(await Effect.runPromise(Fiber.join(f))).toEqual({ choice: "deny" })
  void d
})

test("a plugin that stops moots its grant question", async () => {
  const { inbox } = await setup()
  const f = Effect.runFork(Effect.exit(grantAsk(inbox)("tracker", { question: "Plugin tracker wants to reach a.test.", options: [{ id: "once", label: "Allow once" }], allowOther: false, kind: "grant" })))
  await Bun.sleep(5)
  await Effect.runPromise(inbox.stopped("tracker"))
  expect(inbox.list()[0]).toMatchObject({ state: "moot", moot: "tracker stopped" })
  expect((await Effect.runPromise(Fiber.join(f)))._tag).toBe("Failure")
})
test("zarg's question topics name their thread: an answer goes to that thread", () => {
  expect(threadOfTopic("focused|inq-1")).toBe("focused")
  expect(threadOfTopic("inq-1")).toBe("main")
})
