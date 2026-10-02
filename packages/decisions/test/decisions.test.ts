import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Config, Model, ModelError, type ModelInfo, type ProviderClient, type StreamEvent } from "@zarg/model"
import { confidence, type DecisionRequest, Decisions, layer } from "../src"

const info = (id: string, capabilities: ReadonlyArray<string>): ModelInfo => ({
  id, contextLength: 8192, maxOutputTokens: 1, supportsTools: false, reasoningEfforts: [], capabilities, state: undefined,
})

interface Fake {
  readonly stallInfo?: boolean
  readonly deadlineMs?: number
  readonly systemone?: (body: any) => Effect.Effect<unknown, ModelError>
  readonly chat?: (prompt: string) => ReadonlyArray<StreamEvent>
  readonly roles: Readonly<Record<string, string>>
}

const run = <A, E>(fake: Fake, eff: Effect.Effect<A, E, Decisions>) => {
  const calls = { systemone: [] as Array<any>, chat: [] as Array<any> }
  const client: ProviderClient = {
    stream: () => Stream.empty,
    models: Effect.succeed([]),
    verify: Effect.void,
    ...(fake.systemone
      ? { systemone: (b: unknown) => Effect.flatMap(Effect.sync(() => calls.systemone.push(b)), () => fake.systemone!(b)) }
      : {}),
  }
  const model = Layer.succeed(Model.Model, {
    client: () => Effect.succeed(client),
    list: () => Effect.succeed([]),
    info: (ref) => (fake.stallInfo ? Effect.never : Effect.succeed(info(ref, ref === "r:jevk5" ? ["decision"] : []))),
    warm: () => Effect.void,
    stream: (req) => {
      calls.chat.push(req)
      return Stream.fromIterable(fake.chat?.(String(req.messages[0]?.content)) ?? [])
    },
  })
  const config = Layer.succeed(Config.Config, { providers: {}, roles: fake.roles, extra: {} })
  const decisions = layer(fake.deadlineMs === undefined ? {} : { deadlineMs: fake.deadlineMs })
  return Effect.runPromise(Effect.provide(eff, Layer.provide(decisions, Layer.merge(model, config)))).then((out) => ({ out, calls }))
}

const req: DecisionRequest = {
  state: "two threads edited ST-0004",
  questions: {
    merge: { type: "choice", instructions: "Can both edits apply?", criteria: { compatible: "yes", conflicting: "no" } },
    ready: { type: "noul", instructions: "Enough evidence?" },
    risk: { type: "score", instructions: "How risky?", levels: ["low", "mid", "high"] },
  },
}
const decide = Decisions.use((d) => d.decide(req))
const text = (s: string): ReadonlyArray<StreamEvent> => [{ type: "text", delta: s }, { type: "done", finishReason: "stop" }]

describe("confidence", () => {
  test("1 for a certain answer, 0 for a uniform one", () => {
    expect(confidence([1, 0, 0])).toBe(1)
    expect(confidence([0.5, 0.5])).toBeCloseTo(0, 12)
    expect(confidence([0.9, 0.1])).toBeGreaterThan(0.5)
  })
})

describe("Decisions", () => {
  test("native: a decision-capable role model answers through /systemone", async () => {
    const { out, calls } = await run(
      {
        roles: { decision: "r:jevk5", driver: "r:chat" },
        systemone: () =>
          Effect.succeed({
            answers: {
              merge: { type: "choice", choice: "compatible", probabilities: { compatible: 0.8, conflicting: 0.2 } },
              ready: { type: "noul", noul: 0.9 },
              risk: { type: "score", score: 0.4, probabilities: [0.6, 0.4, 0] },
            },
          }),
      },
      decide,
    )
    expect(out.merge).toMatchObject({ type: "choice", choice: "compatible", probabilities: { compatible: 0.8, conflicting: 0.2 } })
    expect(out.ready).toMatchObject({ type: "noul", answer: true, probability: 0.9 })
    expect(out.risk).toMatchObject({ type: "score", level: "low" })
    expect((out.risk as { score: number }).score).toBeCloseTo(0.4, 12)
    expect(calls.systemone[0]).toMatchObject({ model: "jevk5", questions: { risk: { type: "score", criteria: ["low", "mid", "high"] } } })
    expect(calls.chat.length).toBe(0)
  })

  test("native unavailable falls back to structured output on the fallback role", async () => {
    const { out, calls } = await run(
      {
        roles: { decision: "r:jevk5", driver: "r:chat" },
        systemone: () => Effect.fail(new ModelError({ kind: "status", status: 503, message: "no capacity" })),
        chat: (prompt) =>
          text(
            prompt.includes("Can both") ? '{"probabilities":[0.3,0.7]}' : prompt.includes("Enough") ? '{"probabilities":[0.2,0.8]}' : '{"probabilities":[0,0,1]}',
          ),
      },
      decide,
    )
    expect(out.merge).toMatchObject({ choice: "conflicting" })
    expect(out.ready).toMatchObject({ answer: false })
    expect(out.risk).toMatchObject({ level: "high", score: 2 })
    expect(calls.chat.length).toBe(3)
    expect(calls.chat[0]).toMatchObject({ model: "r:chat", outputSchema: { type: "object" }, maxTokens: 1024 })
  })

  test("without a decision-capable model the fallback is used directly", async () => {
    const { calls } = await run({ roles: { decision: "r:chat", driver: "r:chat" }, chat: () => text('{"probabilities":[1,0]}') }, Decisions.use((d) => d.decide({ state: "s", questions: { ready: { type: "noul", instructions: "?" } } })))
    expect(calls.chat.length).toBe(1)
  })

  test("malformed, truncated and unavailable are typed errors", async () => {
    const one = Decisions.use((d) => Effect.flip(d.decide({ state: "s", questions: { ready: { type: "noul", instructions: "?" } } })))
    expect((await run({ roles: { driver: "r:chat" }, chat: () => text("not json") }, one)).out).toMatchObject({ kind: "malformed" })
    expect((await run({ roles: { driver: "r:chat" }, chat: () => text('{"probabilities":[1,2,3]}') }, one)).out).toMatchObject({ kind: "malformed" })
    expect(
      (await run({ roles: { driver: "r:chat" }, chat: () => [{ type: "text", delta: '{"prob' }, { type: "done", finishReason: "length" }] }, one)).out,
    ).toMatchObject({ kind: "malformed", message: "ready: answer was truncated" })
    expect((await run({ roles: {} }, one)).out).toMatchObject({ kind: "unavailable", message: "no decision model; set roles.decision or roles.driver" })
  })

  test("limits are checked before any model call", async () => {
    const tooFew = Decisions.use((d) => Effect.flip(d.decide({ state: "s", questions: { q: { type: "choice", instructions: "?", criteria: { only: "one" } } } })))
    const { out, calls } = await run({ roles: { driver: "r:chat" } }, tooFew)
    expect(out).toMatchObject({ kind: "invalid", message: "q: 2 to 16 options allowed, got 1" })
    expect(calls.chat.length).toBe(0)
  })
  test("the deadline covers looking up the model, not just answering", async () => {
    const one = Decisions.use((d) => Effect.flip(d.decide({ state: "s", questions: { ready: { type: "noul", instructions: "?" } } })))
    const { out } = await run({ roles: { decision: "r:jevk5", driver: "r:chat" }, stallInfo: true, deadlineMs: 50 }, one)
    expect(out).toMatchObject({ kind: "deadline" })
  })
})
