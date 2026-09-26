import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Redacted, Stream } from "effect"
import { buildRequestBody, openRouterWire, type StreamEvent } from "../src"
import { delta, fakeServer, sse } from "./fake-server"

let stops: Array<() => void> = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})
const serve = (h: Parameters<typeof fakeServer>[0]) => {
  const s = fakeServer(h)
  stops.push(s.stop)
  return s
}
const collect = (s: Stream.Stream<StreamEvent, unknown>) => Effect.runPromise(Stream.runCollect(s))
const collectErr = (s: Stream.Stream<StreamEvent, any>) => Effect.runPromise(Effect.flip(Stream.runCollect(s)))
const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }] }

describe("openRouterWire.stream", () => {
  test("text, reasoning, usage and finish reason", async () => {
    const s = serve(() =>
      sse([
        delta({ reasoning_content: "think" }),
        delta({ content: "Hel" }),
        delta({ content: "lo" }, "stop"),
        { usage: { prompt_tokens: 5, completion_tokens: 2, reasoning_tokens: 1 } },
        "data: [DONE]\n\n",
      ]),
    )
    const events = await collect(openRouterWire({ baseUrl: s.url }).stream(req))
    expect(events).toEqual([
      { type: "reasoning", delta: "think" },
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "usage", usage: { promptTokens: 5, completionTokens: 2, reasoningTokens: 1, cacheHitTokens: 0, cacheMissTokens: 5 } },
      { type: "done", finishReason: "stop" },
    ])
  })

  test("tool calls are assembled across chunks and emitted before done", async () => {
    const s = serve(() =>
      sse([
        delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "exec", arguments: '{"co' } }] }),
        delta({ tool_calls: [{ index: 1, id: "c2", function: { name: "exec", arguments: "{}" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'de":"1"}' } }] }, "tool_calls"),
      ]),
    )
    const events = await collect(openRouterWire({ baseUrl: s.url }).stream(req))
    expect(events).toEqual([
      { type: "toolCall", call: { id: "c1", type: "function", function: { name: "exec", arguments: '{"code":"1"}' } } },
      { type: "toolCall", call: { id: "c2", type: "function", function: { name: "exec", arguments: "{}" } } },
      { type: "done", finishReason: "tool_calls" },
    ])
  })

  test("a stream without finish_reason ends with done and no reason", async () => {
    const s = serve(() => sse([delta({ content: "x" })]))
    const events = await collect(openRouterWire({ baseUrl: s.url }).stream(req))
    expect(events.at(-1)).toEqual({ type: "done" })
  })

  test("an in-band error frame fails the stream", async () => {
    const s = serve(() => sse([delta({ content: "par" }), { error: { message: "engine dropped the socket", code: 502 } }]))
    const err = await collectErr(openRouterWire({ baseUrl: s.url }).stream(req))
    expect(err).toMatchObject({ _tag: "ModelError", kind: "stream", message: "engine dropped the socket", status: 502 })
  })

  test("warming comments keep the connection alive but do not count as output", async () => {
    const ok = serve(() => sse([": warming m\n\n", 30, ": warming m\n\n", 30, delta({ content: "ready" })]))
    const events = await collect(openRouterWire({ baseUrl: ok.url, timeouts: { idleMs: 50, firstOutputMs: 500 } }).stream(req))
    expect(events[0]).toEqual({ type: "text", delta: "ready" })

    const cold = serve(() => sse([": warming m\n\n", 30, ": warming m\n\n", 30, ": warming m\n\n", 30, delta({ content: "late" })]))
    const err = await collectErr(openRouterWire({ baseUrl: cold.url, timeouts: { idleMs: 50, firstOutputMs: 70 } }).stream(req))
    expect(err).toMatchObject({ kind: "first-output" })
  })

  test("silence after output is an idle timeout", async () => {
    const s = serve(() => sse([delta({ content: "a" }), 200, delta({ content: "b" })]))
    const err = await collectErr(openRouterWire({ baseUrl: s.url, timeouts: { idleMs: 50, firstOutputMs: 1000 } }).stream(req))
    expect(err).toMatchObject({ kind: "timeout" })
  })

  test("429 honours Retry-After and succeeds; persistent 500 fails after the retries", async () => {
    let n = 0
    const flaky = serve(() => (++n < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : sse([delta({ content: "ok" })])))
    const events = await collect(openRouterWire({ baseUrl: flaky.url }).stream(req))
    expect(events[0]).toEqual({ type: "text", delta: "ok" })
    expect(flaky.requests.length).toBe(3)

    const down = serve(() => new Response("boom", { status: 500 }))
    const err = await collectErr(openRouterWire({ baseUrl: down.url, retries: 2, backoffMs: 1 }).stream(req))
    expect(err).toMatchObject({ kind: "status", status: 500 })
    expect(down.requests.length).toBe(3)
  })

  test("401 is not retried; the key is sent as a bearer token", async () => {
    const s = serve(() => new Response("bad key", { status: 401 }))
    const err = await collectErr(openRouterWire({ baseUrl: s.url, apiKey: Redacted.make("sk-test") }).stream(req))
    expect(err).toMatchObject({ kind: "status", status: 401 })
    expect(s.requests.length).toBe(1)
    expect(s.requests[0]?.auth).toBe("Bearer sk-test")
  })
})

describe("openRouterWire.models", () => {
  test("parses limits, tool support and zarg-router capabilities from /models rows", async () => {
    const s = serve(() =>
      Response.json({
        data: [
          { id: "coder", context_length: 131072, top_provider: { context_length: 131072, max_completion_tokens: 32768 }, supported_parameters: ["tools", "reasoning"], reasoning: { supported_efforts: ["low", "high"] }, state: "cold" },
          { id: "jevk5", context_length: 8192, top_provider: { context_length: 8192, max_completion_tokens: 1 }, supported_parameters: [], x_zarg_capabilities: ["decision"] },
        ],
      }),
    )
    const models = await Effect.runPromise(openRouterWire({ baseUrl: s.url }).models)
    expect(models).toEqual([
      { id: "coder", contextLength: 131072, maxOutputTokens: 32768, supportsTools: true, reasoningEfforts: ["low", "high"], capabilities: [], state: "cold" },
      { id: "jevk5", contextLength: 8192, maxOutputTokens: 1, supportsTools: false, reasoningEfforts: [], capabilities: ["decision"], state: undefined },
    ])
  })
})

describe("buildRequestBody", () => {
  test("OpenRouter dialect: tools, reasoning, streaming usage, fixed key order", () => {
    const body = JSON.parse(
      buildRequestBody({
        model: "m",
        messages: [{ role: "assistant", content: null }],
        tools: [{ name: "exec", description: "run", parameters: { type: "object" } }],
        maxTokens: 10,
        reasoning: { effort: "low" },
      }),
    )
    expect(Object.keys(body)).toEqual(["model", "messages", "tools", "max_tokens", "stream", "stream_options", "reasoning"])
    expect(body.messages[0]).toEqual({ role: "assistant", content: "" })
    expect(body.reasoning).toEqual({ effort: "low" })
  })

  test("a tool message needs a name; structured output refuses tools", () => {
    expect(() => buildRequestBody({ model: "m", messages: [{ role: "tool", content: "x", toolCallId: "c1" }] })).toThrow("missing name")
    expect(() =>
      buildRequestBody({ model: "m", messages: [], outputSchema: { type: "object" }, tools: [{ name: "t", description: "", parameters: {} }] }),
    ).toThrow("no tools")
  })
})
