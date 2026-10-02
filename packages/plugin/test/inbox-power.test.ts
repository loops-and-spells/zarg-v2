import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fixturePlugin, hostWith } from "./fixtures"

const plugin = (scopes: string) => `
import { Effect, Schema } from "effect"
import { definePlugin, Inbox } from "@zarg/plugin-sdk"
export default definePlugin({ name: "asker", service: "Asker", archetype: "service", config: Schema.Struct({}), scopes: ${scopes},
  methods: {
    ask: { doc: "ask", params: Schema.Struct({}), success: Schema.Unknown, deadlineMs: 150 },
    post: { doc: "post", params: Schema.Struct({}), success: Schema.Unknown },
    settle: { doc: "settle", params: Schema.Struct({ id: Schema.String }), success: Schema.Unknown },
  },
  make: Effect.gen(function* () { const i = yield* Inbox
    return {
      ask: () => i.ask({ kind: "question", title: "Q?", why: "test", answers: [{ id: "a", label: "A" }] }),
      post: () => i.post({ kind: "report", title: "done", why: "test" }),
      settle: ({ id }) => Effect.as(i.settle(id, "gone"), "ok"),
    } }) })`

test("Inbox: ask waits past the call's deadline for the answer; post and settle reach the host with the plugin's name; no scope, refused", async () => {
  const seen: Array<unknown> = []
  const inbox = (plugin: string, op: string, args: unknown) =>
    Effect.gen(function* () {
      seen.push([plugin, op, (args as { topic?: { title?: string }; id?: string }).topic?.title ?? (args as { id?: string }).id])
      if (op === "ask") return yield* Effect.as(Effect.sleep("400 millis"), { answer: "a" })
      return op === "post" ? "T-1" : { notice: "settled" }
    })
  const out = await Effect.runPromise(
    hostWith([await fixturePlugin(plugin(`{ inbox: true }`))], (h) => Effect.all([h.invoke("asker", "ask", {}), h.invoke("asker", "post", {}), h.invoke("asker", "settle", { id: "T-9" })]), { inbox } as never),
  )
  expect(out).toEqual([{ answer: "a" }, "T-1", "ok"])
  expect(seen).toEqual([["asker", "ask", "Q?"], ["asker", "post", "done"], ["asker", "settle", "T-9"]])
  const refused = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(plugin(`{}`))], (h) => h.invoke("asker", "post", {}), { inbox } as never)))
  expect(JSON.stringify(refused)).toContain("has no inbox scope")
})

test("a card's code needs the code scope, not only reading the cards", async () => {
  const src = (scopes: string) => `
import { Effect, Schema } from "effect"
import { definePlugin, Entities } from "@zarg/plugin-sdk"
export default definePlugin({ name: "reader", service: "Reader", archetype: "service", config: Schema.Struct({}), scopes: ${scopes},
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.Unknown } },
  make: Effect.gen(function* () { const e = yield* Entities
    return { go: () => e.code("gherkin/card:S-0001") } }) })`
  const refused = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(src(`{ entities: { read: ["gherkin/*"] } }`))], (h) => h.invoke("reader", "go", {}))))
  expect(JSON.stringify(refused)).toContain("has no code scope")
})
