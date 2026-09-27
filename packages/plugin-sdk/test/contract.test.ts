import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { pluginContract } from "../src"
import { contractDigest } from "../src/tools"

class Notes extends pluginContract("notes", {
  count: { params: Schema.Struct({ prefix: Schema.String }), success: Schema.Number },
}) {}

test("a contract is a typed service tag carrying its plugin's name, with a digest of its methods", async () => {
  expect(Notes.pluginName).toBe("notes")
  expect(contractDigest(Notes)).toMatch(/^[0-9a-f]{64}$/)
  class Same extends pluginContract("notes", { count: { params: Schema.Struct({ prefix: Schema.String }), success: Schema.Number } }) {}
  expect(contractDigest(Same)).toBe(contractDigest(Notes))
  class Changed extends pluginContract("notes", { count: { params: Schema.Struct({ prefix: Schema.Number }), success: Schema.Number } }) {}
  expect(contractDigest(Changed)).not.toBe(contractDigest(Notes))
  const n = await Effect.runPromise(
    Effect.gen(function* () {
      const notes = yield* Notes
      return yield* notes.count({ prefix: "a" })
    }).pipe(Effect.provideService(Notes, { count: () => Effect.succeed(3) })),
  )
  expect(n).toBe(3)
  const typed = (s: Notes["Service"]) => {
    // @ts-expect-error: not in the contract
    return s.remove
  }
  expect(typeof typed).toBe("function")
})
