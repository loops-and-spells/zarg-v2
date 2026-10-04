import { Effect, Schema } from "effect"
import { definePlugin, Files, Inbox } from "@zarg/plugin-sdk"

/** The e2e fixture: a third-party plugin that reads notes (an optional scope), reaches past its manifest, hangs, and asks the operator through the inbox. */
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
  scopes: { inbox: true },
  optional: { fs: { read: ["notes/**"] } },
  commands: [
    { cmd: "/peek", desc: "read a note (asks first)", method: "peek", arg: { kind: "text", hint: "note name" } },
    { cmd: "/escape", desc: "read a file outside its manifest", method: "escape", arg: { kind: "none" } },
    { cmd: "/spin", desc: "never answers", method: "spin", arg: { kind: "none" } },
    { cmd: "/check", desc: "post a check to the inbox", method: "check", arg: { kind: "text", hint: "name" } },
    { cmd: "/block", desc: "ask the operator and wait", method: "block", arg: { kind: "none" } },
  ],
  methods: {
    peek: { doc: "/peek", params: Args, success: Notice },
    escape: { doc: "/escape", params: Args, success: Notice },
    spin: { doc: "/spin", params: Args, success: Notice, deadlineMs: 300 },
    check: { doc: "/check", params: Args, success: Notice },
    block: { doc: "/block", params: Args, success: Notice },
    answered: { doc: "The operator answered a check.", params: Schema.Struct({ id: Schema.String, key: Schema.optionalKey(Schema.String), answer: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }), success: Notice },
  },
  make: Effect.gen(function* () {
    const files = yield* Files
    const inbox = yield* Inbox
    return {
      peek: ({ args }) => files.read(`notes/${args[0] ?? "a"}.md`).pipe(Effect.map((t) => ({ notice: `note: ${t.trim()}` })), Effect.catch(failed)),
      escape: () => files.read("secrets.txt").pipe(Effect.map((t) => ({ notice: `read: ${t.trim()}` })), Effect.catch(failed)),
      spin: () => Effect.never,
      check: ({ args }) =>
        inbox.post({ kind: "probe-check", key: `check:${args[0] ?? "a"}`, title: `Check ${args[0] ?? "a"}`, why: "the probe asks", severity: "medium", answers: [{ id: "keep", label: "Keep", recommended: true }, { id: "drop", label: "Drop", reason: "optional" }] }).pipe(
          Effect.map(() => ({ notice: `posted ${args[0] ?? "a"}` })),
          Effect.catch(failed),
        ),
      block: () =>
        inbox.ask({ kind: "probe-gate", title: "Probe waits for a go", why: "the probe asks", answers: [{ id: "go", label: "Go", recommended: true }, { id: "stop", label: "Stop" }] }).pipe(
          // What it heard, as a report the operator sees.
          Effect.flatMap((r) => inbox.post({ kind: "probe-heard", key: "heard:gate", title: `Gate: ${r.answer ?? "none"}`, why: "the probe heard it" })),
          Effect.map(() => ({ notice: "gate passed" })),
          Effect.catch(failed),
        ),
      // What it heard, as a report the operator sees.
      answered: ({ key, answer, text }) =>
        inbox.post({ kind: "probe-heard", key: `heard:${key}`, title: `Heard ${String(key).replace("check:", "")}: ${answer ?? ""}${text !== undefined && text !== "" ? ` (${text})` : ""}`, why: "the probe heard it" }).pipe(
          Effect.map(() => ({ notice: "heard" })),
          Effect.catch(failed),
        ),
    }
  }),
})
