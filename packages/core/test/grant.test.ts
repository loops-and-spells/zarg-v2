import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { grantAsk } from "../src/grant"
import { setup } from "./inbox-helper"

test("a grant question is a blocking grant topic; its answer is the grant's choice; a restart makes it moot", async () => {
  const { inbox, d } = await setup()
  const ask = grantAsk(inbox)
  const f = Effect.runFork(ask({ plugin: "tracker" }, { question: "Plugin tracker wants to reach a.test.", options: [{ id: "once", label: "Allow once", recommended: true }, { id: "deny", label: "Deny" }], allowOther: false, kind: "grant" }))
  await Bun.sleep(5)
  const t = inbox.list()[0]!
  expect(t).toMatchObject({ kind: "grant", blocking: true, from: { plugin: "tracker" }, title: "Plugin tracker wants to reach a.test.", answers: [{ id: "once", label: "Allow once", recommended: true }, { id: "deny", label: "Deny" }] })
  await Effect.runPromise(inbox.answer(t.id, { answer: "deny" }))
  expect(await Effect.runPromise(Fiber.join(f))).toEqual({ choice: "deny" })
  void d
})
