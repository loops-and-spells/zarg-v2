import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { type Config, Model, openRouterWire, plain, type Provider } from "../src"
import { delta, fakeServer, sse } from "./fake-server"

const server = fakeServer((req) =>
  new URL(req.url).pathname === "/models"
    ? Response.json({ data: [{ id: "coder", context_length: 1000, supported_parameters: ["tools"] }] })
    : sse([delta({ content: "hi" }, "stop")]),
)
afterAll(() => server.stop())

const local: Provider = {
  name: "local",
  envKeys: [],
  schemaFile: "/dev/null",
  settings: {},
  connect: (settings) => Effect.map(plain("local", settings, "base_url"), (baseUrl) => openRouterWire({ baseUrl })),
}
const config = (base: string): Config.ZargConfig => ({ providers: { local: { base_url: base } }, roles: {}, extra: {} })
const run = <A, E>(f: (m: Model.Model["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(Model.make([local, { ...local, name: "unused" }], config(server.url)), f))

describe("Model", () => {
  test("routes provider:model to the provider and strips the prefix", async () => {
    const events = await run((m) => Stream.runCollect(m.stream({ model: "local:coder", messages: [{ role: "user", content: "x" }] })))
    expect(events[0]).toEqual({ type: "text", delta: "hi" })
    expect(JSON.parse(server.requests.at(-1)!.body).model).toBe("coder")
  })

  test("info reads the /models row", async () => {
    const info = await run((m) => m.info("local:coder"))
    expect(info).toMatchObject({ id: "coder", contextLength: 1000, supportsTools: true })
  })

  test("errors say what to fix", async () => {
    const msg = (ref: string) => run((m) => Effect.flip(m.info(ref))).then((e) => e.message)
    expect(await msg("local:missing")).toBe('local does not list a model "missing"')
    expect(await msg("unused:x")).toBe('provider "unused" is not configured; add [providers.unused] to .zarg/config.toml')
    expect(await msg("nope:x")).toBe('no provider plugin named "nope"')
    expect(await msg("no-colon")).toBe('model reference "no-colon" must look like "provider:model"')
  })

  test("warm is a no-op for a provider without warm-up", async () => {
    await run((m) => m.warm("local:coder"))
  })
})

describe("a completion from a stream", () => {
  test("the text, the tokens, and how it ended: an answer spent on reasoning shows as such", () => {
    const u = (completionTokens: number, reasoningTokens: number) => ({ type: "usage" as const, usage: { promptTokens: 900, completionTokens, reasoningTokens, cacheHitTokens: 0, cacheMissTokens: 0 } })
    expect(Model.completion([{ type: "text", delta: "{\"a\"" }, { type: "text", delta: ":1}" }, u(12, 0), { type: "done", finishReason: "stop" }])).toEqual({ text: "{\"a\":1}", promptTokens: 900, completionTokens: 12, reasoningTokens: 0, finishReason: "stop" })
    expect(Model.completion([{ type: "reasoning", delta: "hmm" }, u(4096, 4096), { type: "done", finishReason: "length" }])).toEqual({ text: "", promptTokens: 900, completionTokens: 4096, reasoningTokens: 4096, finishReason: "length" })
  })
})

test("reconnect picks up a provider configured after start, from the same live config", async () => {
  const fake: Provider = { name: "fake", envKeys: [], schemaFile: "/dev/null", settings: { base_url: "x" }, connect: () => Effect.succeed({ models: Effect.succeed([]), verify: Effect.void, stream: () => Stream.empty } as never) }
  const config = { providers: {} as Record<string, Record<string, string>>, roles: {}, extra: {} }
  const out = await Effect.runPromise(Effect.gen(function* () {
    const m = yield* Model.make([fake], config)
    const before = yield* Effect.flip(m.client("fake"))
    config.providers.fake = { base_url: "x" }
    yield* m.reconnect!
    return { before: before.message, after: yield* Effect.map(m.client("fake"), () => "connected") }
  }))
  expect(out).toEqual({ before: 'provider "fake" is not configured; add [providers.fake] to .zarg/config.toml', after: "connected" })
})
