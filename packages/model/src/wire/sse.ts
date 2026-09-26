import { Effect, Stream } from "effect"
import { ModelError, type StreamEvent, type ToolCall, type Usage } from "./types"

export interface SseTimeouts {
  /** Longest silence between chunks. */
  readonly idleMs: number
  /** Longest wait for the first text, reasoning or tool call. Keep-alive comments do not count. */
  readonly firstOutputMs: number
}

// Two shapes in the wild: OpenAI/OpenRouter nest reasoning_tokens under completion_tokens_details,
// SGLang reports it flat on usage. Ported from zarg v1.
export const mapUsage = (u: any): Usage => ({
  ...([u.prompt_tokens, u.completion_tokens].every((n) => Number.isSafeInteger(n) && n >= 0)
    ? {}
    : { tokenCountsComplete: false }),
  promptTokens: u.prompt_tokens ?? 0,
  completionTokens: u.completion_tokens ?? 0,
  reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0,
  cacheHitTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
  cacheMissTokens:
    u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0)),
  ...(u.cost !== undefined ? { costUsd: u.cost } : {}),
})

interface State {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  readonly decoder: TextDecoder
  readonly deadline: number
  buf: string
  readonly toolCalls: Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>
  finishReason: string | undefined
  sawOutput: boolean
  done: boolean
  events: Array<StreamEvent>
}

const read = (s: State, t: SseTimeouts) => {
  const ms = s.sawOutput ? t.idleMs : Math.max(0, Math.min(t.idleMs, s.deadline - Date.now()))
  const kind = s.sawOutput || s.deadline - Date.now() > t.idleMs ? "timeout" : "first-output"
  return Effect.tryPromise({
    try: () => s.reader.read(),
    catch: (e) => new ModelError({ kind: "transport", message: e instanceof Error ? e.message : String(e) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: ms,
      orElse: () =>
        Effect.fail(
          new ModelError({
            kind,
            message: kind === "first-output" ? `no output within ${t.firstOutputMs}ms` : `stream idle for ${t.idleMs}ms`,
          }),
        ),
    }),
    Effect.tapError(() => Effect.sync(() => void s.reader.cancel().catch(() => {}))),
  )
}

/**
 * Parse an OpenAI-style SSE body into StreamEvents. Tool calls are emitted, assembled, before `done`.
 * `startedAt` is when the request was sent, so time spent waiting for headers counts toward first output.
 */
export const parseSse = (response: Response, t: SseTimeouts, startedAt: number = Date.now()): Stream.Stream<StreamEvent, ModelError> => {
  const state: State = {
    reader: response.body!.getReader(),
    decoder: new TextDecoder(),
    deadline: startedAt + t.firstOutputMs,
    buf: "",
    toolCalls: new Map(),
    finishReason: undefined,
    sawOutput: false,
    done: false,
    events: [],
  }

  /** Handle one SSE frame (the text between blank lines). */
  const frame = (s: State, text: string): Effect.Effect<void, ModelError> =>
    Effect.gen(function* () {
      // Lines starting with ":" are comments (zarg-router sends ": warming <model>").
      // Per the SSE spec, one optional space follows "data:", and multiple data lines join with "\n".
      const data = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)))
        .join("\n")
      if (!data || data === "[DONE]") return
      let j: any
      try {
        j = JSON.parse(data)
      } catch (e) {
        return yield* new ModelError({ kind: "stream", message: `bad SSE JSON: ${e instanceof Error ? e.message : String(e)}` })
      }
      // An in-band error frame is a failed stream, never an empty turn.
      if (j.error !== undefined && j.error !== null) {
        const message = typeof j.error === "string" ? j.error : (j.error.message ?? JSON.stringify(j.error))
        return yield* new ModelError({ kind: "stream", message, status: typeof j.error?.code === "number" ? j.error.code : 0 })
      }
      if (j.usage) s.events.push({ type: "usage", usage: mapUsage(j.usage) })
      // Read before the delta guard: some backends send finish_reason on a chunk without a delta.
      const fr = j.choices?.[0]?.finish_reason
      if (fr) s.finishReason = fr
      const delta = j.choices?.[0]?.delta
      if (!delta) return
      const r = delta.reasoning_content ?? delta.reasoning
      if (r) {
        s.sawOutput = true
        s.events.push({ type: "reasoning", delta: r })
      }
      if (delta.content) {
        s.sawOutput = true
        s.events.push({ type: "text", delta: delta.content })
      }
      for (const tc of delta.tool_calls ?? []) {
        s.sawOutput = true
        const cur = s.toolCalls.get(tc.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.function.name = tc.function.name
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
        s.toolCalls.set(tc.index, cur)
      }
    })

  /** Normalise CRLF/CR to LF, keeping a trailing "\r" pending in case its "\n" is in the next chunk. */
  const normalise = (buf: string, final: boolean) => {
    const keep = !final && buf.endsWith("\r") ? "\r" : ""
    const body = keep ? buf.slice(0, -1) : buf
    return body.replace(/\r\n?/g, "\n") + keep
  }

  const step = (s: State): Effect.Effect<readonly [StreamEvent, State] | undefined, ModelError> =>
    Effect.gen(function* () {
      while (true) {
        const head = s.events.shift()
        if (head !== undefined) return [head, s] as const
        if (s.done) return undefined
        const chunk = yield* read(s, t)
        if (chunk.done) {
          // A last frame without a trailing blank line still counts.
          const rest = normalise(s.buf + s.decoder.decode(), true)
          s.buf = ""
          if (rest.trim().length > 0) yield* frame(s, rest)
          for (const call of s.toolCalls.values()) s.events.push({ type: "toolCall", call: call as ToolCall })
          s.events.push({ type: "done", ...(s.finishReason !== undefined ? { finishReason: s.finishReason } : {}) })
          s.done = true
          continue
        }
        s.buf = normalise(s.buf + s.decoder.decode(chunk.value, { stream: true }), false)
        let idx: number
        while ((idx = s.buf.indexOf("\n\n")) !== -1) {
          const text = s.buf.slice(0, idx)
          s.buf = s.buf.slice(idx + 2)
          yield* frame(s, text)
        }
      }
    })

  // Cancel the response body however the stream ends: done, failed, or interrupted by a consumer
  // that stopped early (Stream.take, a timeout). Otherwise the provider keeps generating and billing.
  return Stream.unfold(state, step).pipe(
    Stream.ensuring(Effect.sync(() => void state.reader.cancel().catch(() => {}))),
  )
}
