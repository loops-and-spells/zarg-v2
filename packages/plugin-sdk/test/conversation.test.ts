import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Conversation, defineView, definePlugin } from "../src"

const Talk = defineView("talker", { talk: { kind: "conversation", role: "primary" } })
const plugin = (onMessage: Array<string>) =>
  definePlugin({
    name: "talker",
    service: "Talker",
    archetype: "service",
    config: Schema.Struct({}),
    scopes: { agents: true },
    views: [Talk],
    methods: {
      go: { doc: "go", params: Schema.Struct({}), success: Schema.String },
      message: { doc: "a message", params: Schema.Struct({ agent: Schema.String, text: Schema.String }), success: Schema.Null },
    },
    make: Effect.gen(function* () {
      const talk = yield* Conversation
      return {
        go: () =>
          Effect.gen(function* () {
            yield* talk.say("a-1", "Hello")
            const a = yield* talk.ask("a-1", { question: "Go on?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] })
            return a.choice ?? a.other ?? ""
          }),
        message: ({ text }: { text: string }) => Effect.sync(() => (onMessage.push(text), null)),
      }
    }),
  })

test("say and ask fill the agent's conversation; the developer's answer completes ask; a message reaches the plugin", async () => {
  const pushes: Array<{ section: string; data: { messages: ReadonlyArray<{ text: string }>; question?: { id: string } } }> = []
  const messages: Array<string> = []
  const methods = plugin(messages).serve({ call: async (name: string, args: unknown) => (name === "agents.event" && (args as { event: string }).event === "set" && pushes.push(args as never), null) })
  const going = methods.go!({}) as Promise<string>
  await Bun.sleep(20)
  const asked = pushes.at(-1)!.data
  expect(asked.messages.map((m) => m.text)).toEqual(["Hello"])
  expect(asked.question).toMatchObject({ question: "Go on?" })
  expect(await methods.$answer!({ agent: "a-1", question: asked.question!.id, answer: { choice: "y" } })).toEqual({ notice: "answered" })
  expect(await going).toBe("y")
  expect(pushes.at(-1)!.data.question).toBeUndefined()
  await methods.$message!({ agent: "a-1", text: "thanks" })
  expect(messages).toEqual(["thanks"])
  expect(pushes.at(-1)!.data.messages.map((m) => m.text)).toEqual(["Hello", "thanks"])
})

test("a restarted agent's open question is withdrawn: an answer to it is refused and the question leaves the view", async () => {
  const pushes: Array<{ section: string; data: { question?: unknown } }> = []
  const methods = plugin([]).serve({ call: async (name: string, args: unknown) => (name === "agents.event" && (args as { event: string }).event === "set" && pushes.push(args as never), null) })
  expect(await methods.$answer!({ agent: "a-1", question: "q-from-before", answer: { choice: "y" } })).toEqual({ notice: "that question is no longer open" })
  expect(pushes.at(-1)!.section).toBe("talk")
  expect(pushes.at(-1)!.data.question).toBeUndefined()
})
