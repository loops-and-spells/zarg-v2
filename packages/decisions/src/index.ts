import { Context, Data, Effect, Layer, Stream } from "effect"
import { Config, Model, type ModelError } from "@zarg/model"

export type Question =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "noul"; readonly instructions: string }
  | { readonly type: "score"; readonly instructions: string; readonly levels: ReadonlyArray<string> }

export type Answer =
  | { readonly type: "choice"; readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number }
  | { readonly type: "noul"; readonly answer: boolean; readonly probability: number; readonly confidence: number }
  /** `score` is the probability-weighted level index (0-based); `level` is the most likely level. */
  | { readonly type: "score"; readonly score: number; readonly level: string; readonly probabilities: ReadonlyArray<number>; readonly confidence: number }

export interface DecisionRequest {
  readonly state: string
  readonly questions: Readonly<Record<string, Question>>
}

export type DecisionErrorKind = "invalid" | "unavailable" | "deadline" | "malformed"

export class DecisionError extends Data.TaggedError("DecisionError")<{
  readonly kind: DecisionErrorKind
  readonly message: string
}> {}

export class Decisions extends Context.Service<
  Decisions,
  { readonly decide: (req: DecisionRequest) => Effect.Effect<Readonly<Record<string, Answer>>, DecisionError> }
>()("@zarg/decisions/Decisions") {}

export const LIMITS = { questions: [1, 8], choiceOptions: [2, 16], scoreLevels: [2, 10], deadlineMs: 30_000 } as const

/** `1 - normalized entropy`: 1 when one option has all the mass, 0 when the mass is uniform. */
export const confidence = (ps: ReadonlyArray<number>): number => {
  if (ps.length < 2) return 1
  const h = -ps.reduce((acc, p) => (p > 0 ? acc + p * Math.log(p) : acc), 0)
  return Math.max(0, Math.min(1, 1 - h / Math.log(ps.length)))
}

export const validate = (req: DecisionRequest) => {
  const ids = Object.keys(req.questions)
  const bad = (message: string) => Effect.fail(new DecisionError({ kind: "invalid", message }))
  if (ids.length < LIMITS.questions[0] || ids.length > LIMITS.questions[1]) return bad(`1 to 8 questions allowed, got ${ids.length}`)
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === "choice") {
      const n = Object.keys(q.criteria).length
      if (n < LIMITS.choiceOptions[0] || n > LIMITS.choiceOptions[1]) return bad(`${id}: 2 to 16 options allowed, got ${n}`)
    }
    if (q.type === "score" && (q.levels.length < LIMITS.scoreLevels[0] || q.levels.length > LIMITS.scoreLevels[1])) {
      return bad(`${id}: 2 to 10 levels allowed, got ${q.levels.length}`)
    }
  }
  return Effect.void
}

const normalize = (ps: ReadonlyArray<number>) => {
  const sum = ps.reduce((a, b) => a + b, 0)
  return sum > 0 && ps.every((p) => Number.isFinite(p) && p >= 0) ? ps.map((p) => p / sum) : undefined
}

/** Build an Answer from a probability per option; undefined when the numbers are unusable. */
export const answerFrom = (q: Question, raw: ReadonlyArray<number>): Answer | undefined => {
  const ps = normalize(raw)
  if (ps === undefined) return undefined
  const best = ps.indexOf(Math.max(...ps))
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria)
    if (ps.length !== keys.length) return undefined
    return { type: "choice", choice: keys[best]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, ps[i]!])), confidence: confidence(ps) }
  }
  if (q.type === "noul") {
    if (ps.length !== 2) return undefined
    return { type: "noul", answer: ps[0]! >= 0.5, probability: ps[0]!, confidence: confidence(ps) }
  }
  if (ps.length !== q.levels.length) return undefined
  return {
    type: "score",
    score: ps.reduce((acc, p, i) => acc + p * i, 0),
    level: q.levels[best]!,
    probabilities: ps,
    confidence: confidence(ps),
  }
}

// Native: zarg-router's /systemone. Choice → probabilities by key; noul → p(true); score → probabilities by level.
const nativeBody = (model: string, req: DecisionRequest) => ({
  model,
  state: req.state,
  questions: Object.fromEntries(
    Object.entries(req.questions).map(([id, q]) => [
      id,
      q.type === "score" ? { type: "score", instructions: q.instructions, criteria: q.levels } : q,
    ]),
  ),
})

const fromNative = (req: DecisionRequest, body: any): Record<string, Answer> | undefined => {
  const out: Record<string, Answer> = {}
  for (const [id, q] of Object.entries(req.questions)) {
    const a = body?.answers?.[id]
    let ans: Answer | undefined
    if (q.type === "choice" && a?.probabilities) ans = answerFrom(q, Object.keys(q.criteria).map((k) => Number(a.probabilities[k])))
    if (q.type === "noul" && typeof a?.noul === "number") ans = answerFrom(q, [a.noul, 1 - a.noul])
    if (q.type === "score" && Array.isArray(a?.probabilities)) ans = answerFrom(q, a.probabilities.map(Number))
    if (q.type === "score" && ans === undefined && typeof a?.score === "number") {
      // Only the weighted score came back: put the mass on the two nearest levels.
      const i = Math.floor(a.score)
      const frac = a.score - i
      const ps = q.levels.map((_, k) => (k === i ? 1 - frac : k === i + 1 ? frac : 0))
      ans = answerFrom(q, ps)
    }
    if (ans === undefined) return undefined
    out[id] = ans
  }
  return out
}

// Fallback: one structured-output request per question, each in its own context, no tools.
const fallbackSchema = (q: Question) => ({
  type: "object",
  additionalProperties: false,
  required: ["probabilities"],
  properties: {
    probabilities: {
      type: "array",
      items: { type: "number" },
      description:
        q.type === "choice"
          ? `probability of each option, in this order: ${Object.keys(q.criteria).join(", ")}`
          : q.type === "noul"
            ? "probability of true, then probability of false"
            : `probability of each level, in this order: ${q.levels.join(", ")}`,
    },
  },
})

const fallbackPrompt = (state: string, q: Question) =>
  [
    "Judge the question against the state. Answer only with the JSON object.",
    `State:\n${state}`,
    `Question: ${q.instructions}`,
    q.type === "choice"
      ? `Options:\n${Object.entries(q.criteria).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`
      : q.type === "score"
        ? `Levels (lowest first):\n${q.levels.map((l, i) => `${i}. ${l}`).join("\n")}`
        : "Answer true or false.",
  ].join("\n\n")

export interface DecisionsOptions {
  /** Role whose model answers natively (needs the "decision" capability). */
  readonly role?: string
  /** Chat role used for the structured fallback. */
  readonly fallbackRole?: string
  /** Deadline for a whole decision, including looking up the model. */
  readonly deadlineMs?: number
}

export const make = (opts: DecisionsOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* Config.Config
    const model = yield* Model.Model
    const role = opts.role ?? "decision"
    const fallbackRole = opts.fallbackRole ?? "driver"
    const deadlineMs = opts.deadlineMs ?? LIMITS.deadlineMs

    const native = (ref: string, req: DecisionRequest) =>
      Effect.gen(function* () {
        const { provider, model: id } = yield* Model.splitRef(ref)
        const client = yield* model.client(provider)
        if (client.systemone === undefined) return yield* new DecisionError({ kind: "unavailable", message: `${provider} has no decision endpoint` })
        const body = yield* client.systemone(nativeBody(id, req))
        const answers = fromNative(req, body)
        if (answers === undefined) return yield* new DecisionError({ kind: "malformed", message: `${ref} returned answers that do not fit the questions` })
        return answers
      })

    const structured = (ref: string, req: DecisionRequest) =>
      Effect.forEach(
        Object.entries(req.questions),
        ([id, q]) =>
          Effect.gen(function* () {
            const events = yield* Stream.runCollect(
              model.stream({
                model: ref,
                messages: [{ role: "user", content: fallbackPrompt(req.state, q) }],
                outputSchema: fallbackSchema(q),
                maxTokens: 1024,
              }),
            )
            const done = events.find((e) => e.type === "done")
            if (done?.type === "done" && done.finishReason === "length") {
              return yield* new DecisionError({ kind: "malformed", message: `${id}: answer was truncated` })
            }
            const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")
            const parsed = yield* Effect.try({
              try: () => JSON.parse(text) as { probabilities?: unknown },
              catch: () => new DecisionError({ kind: "malformed", message: `${id}: fallback answer is not JSON` }),
            })
            const ans = Array.isArray(parsed.probabilities) ? answerFrom(q, parsed.probabilities.map(Number)) : undefined
            if (ans === undefined) return yield* new DecisionError({ kind: "malformed", message: `${id}: fallback probabilities do not fit the question` })
            return [id, ans] as const
          }),
        { concurrency: 8 },
      ).pipe(Effect.map((entries): Record<string, Answer> => Object.fromEntries(entries)))

    const toDecisionError = (e: ModelError | DecisionError) =>
      e._tag === "DecisionError" ? e : new DecisionError({ kind: "unavailable", message: e.message })

    const answer = (req: DecisionRequest) =>
      Effect.gen(function* () {
        const nativeRef = config.roles[role]
        const nativeOk =
          nativeRef !== undefined &&
          (yield* model.info(nativeRef).pipe(
            Effect.map((i) => i.capabilities.includes("decision")),
            Effect.orElseSucceed(() => false),
          ))
        const answers: Record<string, Answer> = yield* nativeOk
          ? native(nativeRef!, req).pipe(
              Effect.mapError(toDecisionError),
              Effect.catchTag("DecisionError", (e) =>
                e.kind === "unavailable" && config.roles[fallbackRole] !== undefined
                  ? structured(config.roles[fallbackRole]!, req).pipe(Effect.mapError(toDecisionError))
                  : Effect.fail(e),
              ),
            )
          : config.roles[fallbackRole] !== undefined
            ? structured(config.roles[fallbackRole]!, req).pipe(Effect.mapError(toDecisionError))
            : Effect.fail(new DecisionError({ kind: "unavailable", message: "no decision model (set a default with /models)" }))
        return { answers, transport: nativeOk ? "native" : "structured" }
      })

    const decide = (req: DecisionRequest) =>
      Effect.gen(function* () {
        yield* validate(req)
        const started = Date.now()
        // One deadline around everything, including the /models lookup.
        const { answers, transport } = yield* answer(req).pipe(
          Effect.timeoutOrElse({
            duration: deadlineMs,
            orElse: () => Effect.fail(new DecisionError({ kind: "deadline", message: `no decision within ${deadlineMs}ms` })),
          }),
        )
        yield* Effect.logInfo("decision").pipe(
          Effect.annotateLogs({
            transport,
            latencyMs: Date.now() - started,
            confidence: Object.values(answers).map((a) => a.confidence.toFixed(3)).join(","),
          }),
        )
        return answers
      })

    return { decide } satisfies Decisions["Service"]
  })

export const layer = (opts: DecisionsOptions = {}) => Layer.effect(Decisions, make(opts))
