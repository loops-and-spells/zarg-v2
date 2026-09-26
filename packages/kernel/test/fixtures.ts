import { Effect, Schema } from "effect"
import { bind, defineService } from "../src"

export const Notes = defineService("Notes", "A tiny note store for tests.", {
  add: { doc: "Store a note; returns its id.", params: Schema.Struct({ text: Schema.String }), success: Schema.Struct({ id: Schema.String }) },
  get: { doc: "Read a note by id.", params: Schema.Struct({ id: Schema.String }), success: Schema.String },
  fail: { doc: "Always fails with Nope.", params: Schema.Struct({}), success: Schema.String },
  slow: { doc: "Wait, then return.", params: Schema.Struct({ ms: Schema.Number }), success: Schema.String },
})

/** Bound Notes with observable side effects for assertions. */
export const notes = () => {
  const store = new Map<string, string>()
  const seen = { interrupted: 0, calls: 0 }
  const bound = bind(Notes, {
    add: ({ text }) =>
      Effect.sync(() => {
        seen.calls++
        const id = `n${store.size + 1}`
        store.set(id, text)
        return { id }
      }),
    get: ({ id }) => {
      const v = store.get(id)
      return v === undefined ? Effect.fail({ _tag: "NotFound", message: `no note ${id}` }) : Effect.succeed(v)
    },
    fail: () => Effect.fail({ _tag: "Nope", message: "always fails" }),
    slow: ({ ms }) =>
      Effect.sleep(ms).pipe(
        Effect.as("slept"),
        Effect.onInterrupt(() => Effect.sync(() => void seen.interrupted++)),
      ),
  })
  return { bound, store, seen }
}
