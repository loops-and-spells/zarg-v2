import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fixturePlugin, hostWith } from "./fixtures"

const src = `
import { Effect, Schema } from "effect"
import { Agents, definePlugin } from "@zarg/plugin-sdk"
export default definePlugin({ name: "opener", service: "Opener", archetype: "agent", config: Schema.Struct({}), scopes: { agents: true },
  commands: [{ cmd: "/open-it", desc: "open", method: "go", arg: { kind: "none" } }],
  methods: {
    act: { doc: "act", params: Schema.Unknown, success: Schema.Unknown },
    go: { doc: "go", params: Schema.Unknown, success: Schema.Unknown },
    quiet: { doc: "quiet", params: Schema.Unknown, success: Schema.Unknown },
  },
  make: Effect.gen(function* () {
    const a = yield* Agents
    const ping = (why: string) => Effect.as(a.step({ id: "o", text: why, gesture: true } as never), null)
    return { act: () => ping("act"), go: () => ping("go"), quiet: () => ping("quiet") }
  }) })`
test("a plugin's events carry the host's gesture: true inside act and its commands, false otherwise; a plugin cannot claim one", async () => {
  const seen: Array<{ text?: string; gesture?: boolean }> = []
  await Effect.runPromise(hostWith([await fixturePlugin(src)], (h) => Effect.all([h.invoke("opener", "act", {}), h.invoke("opener", "go", {}), h.invoke("opener", "quiet", {})]), { agents: (_p, e) => void seen.push(e as never) }))
  expect(seen.map((e) => [e.text, e.gesture])).toEqual([["act", true], ["go", true], ["quiet", false]])
})
