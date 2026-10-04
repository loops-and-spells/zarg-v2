import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { completeWith } from "../src/live"

test("a plugin's completion with no model for its role (and no default) fails pointing at /models, never on a stub", async () => {
  const model = { stream: () => Stream.empty } as never
  const e = await Effect.runPromise(Effect.flip(completeWith({}, model)({ role: "rehearse", messages: [] })))
  expect((e as { message: string }).message).toBe('no model for role "rehearse" (set a default with /models)')
})
