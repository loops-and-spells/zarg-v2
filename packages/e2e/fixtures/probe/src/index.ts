import { Effect, Schema } from "effect"
import { definePlugin, Files } from "@zarg/plugin-sdk"

/** The e2e fixture: a third-party plugin that reads notes (an optional scope), reaches past its manifest, and hangs. */
const Args = Schema.Struct({ args: Schema.Array(Schema.String) })
const Notice = Schema.Struct({ notice: Schema.String })
// Short notices: the status line has room for a few words.
const failed = (e: unknown) => {
  const m = String((e as { message?: unknown }).message ?? e)
  return Effect.succeed({ notice: m.includes("not declared") ? "undeclared" : m.includes("denied") ? "refused: denied" : `refused: ${m}` })
}

export default definePlugin({
  name: "probe",
  service: "Probe",
  archetype: "service",
  config: Schema.Struct({}),
  scopes: {},
  optional: { fs: { read: ["notes/**"] } },
  commands: [
    { cmd: "/peek", desc: "read a note (asks first)", method: "peek", arg: { kind: "text", hint: "note name" } },
    { cmd: "/escape", desc: "read a file outside its manifest", method: "escape", arg: { kind: "none" } },
    { cmd: "/spin", desc: "never answers", method: "spin", arg: { kind: "none" } },
  ],
  methods: {
    peek: { doc: "/peek", params: Args, success: Notice },
    escape: { doc: "/escape", params: Args, success: Notice },
    spin: { doc: "/spin", params: Args, success: Notice, deadlineMs: 300 },
  },
  make: Effect.gen(function* () {
    const files = yield* Files
    return {
      peek: ({ args }) => files.read(`notes/${args[0] ?? "a"}.md`).pipe(Effect.map((t) => ({ notice: `note: ${t.trim()}` })), Effect.catch(failed)),
      escape: () => files.read("secrets.txt").pipe(Effect.map((t) => ({ notice: `read: ${t.trim()}` })), Effect.catch(failed)),
      spin: () => Effect.never,
    }
  }),
})
