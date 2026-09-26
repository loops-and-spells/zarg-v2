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
