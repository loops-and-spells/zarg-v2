import { Effect, Redacted, Stream } from "effect"
import { buildRequestBody } from "./serialize"
import { parseSse, type SseTimeouts } from "./sse"
import { type ModelInfo, ModelError, type StreamEvent, type WireRequest } from "./types"

/** A provider's connection, as provider plugins build it. */
export interface WireClient {
  readonly stream: (req: WireRequest) => Stream.Stream<StreamEvent, ModelError>
  readonly models: Effect.Effect<ReadonlyArray<ModelInfo>, ModelError>
  /** A cheap authenticated call (GET /models) that fails on bad credentials. */
  readonly verify: Effect.Effect<void, ModelError>
}

export interface WireOptions {
  readonly baseUrl: string
  readonly apiKey?: Redacted.Redacted<string>
  readonly headers?: Readonly<Record<string, string>>
  readonly timeouts?: Partial<SseTimeouts>
  /** Attempts after the first, for network errors, 429 and 5xx. */
  readonly retries?: number
  /** Base of the jittered exponential backoff when no Retry-After is sent. */
  readonly backoffMs?: number
  /** Deadline for non-streaming requests (GET /models), including waiting for headers. */
  readonly requestTimeoutMs?: number
  readonly fetch?: typeof fetch
}

const DEFAULT_TIMEOUTS: SseTimeouts = { idleMs: 300_000, firstOutputMs: 600_000 }

// Retry-After is delay-seconds or an HTTP date; otherwise full-jitter exponential backoff.
const retryDelay = (res: Response | undefined, attempt: number, backoffMs: number) => {
  const ra = res?.headers.get("retry-after")
  if (ra) {
    const secs = Number(ra)
    if (!Number.isNaN(secs)) return Math.max(0, secs * 1000)
    const at = Date.parse(ra)
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  }
  return Math.random() * backoffMs * 2 ** attempt + 1
}

export const parseModelRow = (m: any): ModelInfo => ({
  id: String(m.id),
  contextLength: Number(m.top_provider?.context_length ?? m.context_length ?? 0),
  maxOutputTokens: m.top_provider?.max_completion_tokens ?? undefined,
  supportsTools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"),
  reasoningEfforts: m.reasoning?.supported_efforts ?? [],
  capabilities: m.x_zarg_capabilities ?? [],
  state: typeof m.state === "string" ? m.state : undefined,
})

/** A client for any OpenRouter-compatible `/chat/completions` endpoint (OpenRouter, zarg-router). */
export const openRouterWire = (o: WireOptions): WireClient => {
  const f = o.fetch ?? fetch
  const retries = o.retries ?? 3
  const backoffMs = o.backoffMs ?? 100
  const timeouts = { ...DEFAULT_TIMEOUTS, ...o.timeouts }
  const requestTimeoutMs = o.requestTimeoutMs ?? 30_000
  const deadline = <A>(ms: number, kind: "timeout" | "first-output", what: string) => (eff: Effect.Effect<A, ModelError>) =>
    eff.pipe(
      Effect.timeoutOrElse({
        duration: ms,
        orElse: () => Effect.fail(new ModelError({ kind, message: `${what}: no response within ${ms}ms` })),
      }),
    )
  const headers = (json: boolean): Record<string, string> => ({
    ...(json ? { "content-type": "application/json" } : {}),
    ...(o.apiKey ? { authorization: `Bearer ${Redacted.value(o.apiKey)}` } : {}),
    ...o.headers,
  })

  const send = (path: string, init: RequestInit): Effect.Effect<Response, ModelError> => {
    const attempt = (n: number): Effect.Effect<Response, ModelError> =>
      Effect.tryPromise({
        try: (signal) => f(`${o.baseUrl}${path}`, { ...init, signal }),
        catch: (e) => new ModelError({ kind: "transport", message: e instanceof Error ? e.message : String(e) }),
      }).pipe(
        Effect.catch((e) =>
          n < retries ? Effect.flatMap(Effect.sleep(retryDelay(undefined, n, backoffMs)), () => attempt(n + 1)) : Effect.fail(e),
        ),
        Effect.flatMap((res) => {
          if ((res.status === 429 || res.status >= 500) && n < retries) {
            return Effect.flatMap(Effect.sleep(retryDelay(res, n, backoffMs)), () => attempt(n + 1))
          }
          if (!res.ok) {
            return Effect.flatMap(
              Effect.promise(() => res.text().catch(() => "")),
              (body) => Effect.fail(new ModelError({ kind: "status", status: res.status, message: `${res.status} ${body}`.trim() })),
            )
          }
          return Effect.succeed(res)
        }),
      )
    return attempt(0)
  }

  const json = (res: Response) =>
    Effect.tryPromise({
      try: () => res.json() as Promise<any>,
      catch: (e) => new ModelError({ kind: "transport", message: e instanceof Error ? e.message : String(e) }),
    })

  const models = Effect.flatMap(send("/models", { method: "GET", headers: headers(false) }), json).pipe(
    deadline(requestTimeoutMs, "timeout", "GET /models"),
    Effect.map((body) => (Array.isArray(body?.data) ? body.data.map(parseModelRow) : [])),
  )

  return {
    stream: (req) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const body = yield* Effect.try({
            try: () => buildRequestBody(req),
            catch: (e) => new ModelError({ kind: "config", message: e instanceof Error ? e.message : String(e) }),
          })
          // The first-output clock starts before the request: waiting for headers counts too.
          const startedAt = Date.now()
          const res = yield* send("/chat/completions", { method: "POST", headers: headers(true), body }).pipe(
            deadline(timeouts.firstOutputMs, "first-output", "POST /chat/completions"),
          )
          return parseSse(res, timeouts, startedAt)
        }),
      ),
    models,
    verify: Effect.asVoid(models),
  }
}
