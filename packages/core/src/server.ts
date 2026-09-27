import { Context, type Duration, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RunAgentInputSchema } from "@ag-ui/core/schemas"
import type { WireEvent } from "./events"
import type { ThreadLog } from "./log"
import type { Thread } from "./thread"

/** Driver threads by id. */
export class Threads extends Context.Service<
  Threads,
  {
    /** The thread with this id, created on first use with the given focus. */
    readonly get: (id: string, focus: ReadonlyArray<string>) => Effect.Effect<Thread>
    readonly list: () => ReadonlyArray<Thread>
    /** Add a thread that exists from now on (the plan and implement views, when reconcile starts). */
    readonly add: (thread: Thread) => void
  }
>()("@zarg/core/Threads") {}

/** The event log every thread writes to. */
export class Log extends Context.Service<Log, ThreadLog>()("@zarg/core/Log") {}

/** What `/reconcile` did: on (with how many cards are pending), or why reconcile stays off. */
export interface ReconcileAnswer {
  readonly on: boolean
  readonly reason?: string
  readonly pending?: number
}

/** Turn plan and implement on for this session (`POST /reconcile`), even when the config leaves them off. */
export class ReconcileControl extends Context.Service<ReconcileControl, { readonly turnOn: Effect.Effect<ReconcileAnswer> }>()("@zarg/core/ReconcileControl") {}

/** YOLO on or off (`POST /yolo`): for every plugin, or one; answers whether any plugin is in YOLO now. */
export class YoloControl extends Context.Service<YoloControl, { readonly set: (on: boolean, plugin?: string) => Effect.Effect<{ readonly on: boolean }> }>()("@zarg/core/YoloControl") {}

/** The bearer token every request must carry (from `.zarg/run/core.json`). */
export class Token extends Context.Service<Token, string>()("@zarg/core/Token") {}

/** A thread id names its log file, `.zarg/threads/<id>.jsonl`. */
export const THREAD_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

/** How often a quiet SSE stream sends a `: ping` comment (Bun closes connections idle for 10s). */
export const Heartbeat = Context.Reference<Duration.Input>("@zarg/core/Heartbeat", { defaultValue: () => "5 seconds" })

const encoder = new TextEncoder()
const ping = encoder.encode(": ping\n\n")

/** An SSE response: each event as `data: <json>\n\n`. A client that disconnects interrupts only this stream. */
const sse = (events: Stream.Stream<WireEvent>, heartbeat: Duration.Input) =>
  HttpServerResponse.stream(
    events.pipe(
      Stream.map((e) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`)),
      // Comments keep the connection alive through long model turns; clients ignore them. The stream ends with the events.
      Stream.merge(Stream.tick(heartbeat).pipe(Stream.drop(1), Stream.as(ping)), { haltStrategy: "left" }),
    ),
    { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } },
  )

const error = (status: number, message: string) => HttpServerResponse.jsonUnsafe({ error: message }, { status })

/** Every route needs `Authorization: Bearer <token>`. */
const auth = HttpRouter.middleware(
  Effect.gen(function* () {
    const token = yield* Token
    return (app) =>
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        if (req.headers.authorization !== `Bearer ${token}`) return error(401, "unauthorized")
        return yield* app
      })
  }),
  { global: true },
)

const searchParam = (req: HttpServerRequest.HttpServerRequest, name: string) => new URL(req.url, "http://core").searchParams.get(name)

const routes = HttpRouter.addAll(
  Effect.gen(function* () {
    const threads = yield* Threads
    const control = yield* ReconcileControl
    const yolo = yield* YoloControl
    const heartbeat = yield* Heartbeat
    const log = yield* Log
    // Only a user message this core has not seen yet counts as new input.
    const seenMessages = new Set<string>()
    return [
      HttpRouter.route(
        "POST",
        "/runs",
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest
          const body = yield* req.json.pipe(Effect.orElseSucceed(() => undefined))
          const parsed = RunAgentInputSchema.safeParse(body)
          if (!parsed.success) return error(400, `invalid RunAgentInput: ${parsed.error.message}`)
          const input = parsed.data
          if (!THREAD_ID.test(input.threadId)) return error(400, `invalid threadId "${input.threadId}": use letters, digits, ".", "_" or "-"`)
          const focusProp = (input.forwardedProps as { focus?: unknown } | undefined)?.focus
          const focus = Array.isArray(focusProp) ? focusProp.map(String) : []
          const lastMsg = input.messages.at(-1)
          const fresh = lastMsg !== undefined && lastMsg.role === "user" && !seenMessages.has(lastMsg.id)
          for (const m of input.messages) seenMessages.add(m.id)
          const message = fresh && typeof lastMsg.content === "string" ? lastMsg.content : undefined
          const resume = (input as { resume?: Array<{ interruptId: string; payload?: unknown }> }).resume
          const thread = yield* threads.get(input.threadId, focus)
          return sse(thread.run({ runId: input.runId, ...(message !== undefined ? { message } : {}), ...(resume ? { resume } : {}) }), heartbeat)
        }),
      ),
      HttpRouter.route(
        "GET",
        "/stream",
        Effect.map(HttpServerRequest.HttpServerRequest, (req) => sse(log.stream(Number(searchParam(req, "since") ?? 0)), heartbeat)),
      ),
      HttpRouter.route("POST", "/reconcile", Effect.map(control.turnOn, (answer) => HttpServerResponse.jsonUnsafe(answer))),
      HttpRouter.route(
        "POST",
        "/yolo",
        Effect.gen(function* () {
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { on?: unknown; plugin?: unknown }
          if (typeof body.on !== "boolean") return error(400, `/yolo needs { "on": true | false }`)
          if (body.plugin !== undefined && typeof body.plugin !== "string") return error(400, `/yolo "plugin" must be a plugin name`)
          return HttpServerResponse.jsonUnsafe(yield* yolo.set(body.on, body.plugin as string | undefined))
        }),
      ),
      HttpRouter.route(
        "GET",
        "/threads",
        Effect.sync(() => HttpServerResponse.jsonUnsafe(threads.list().map((t) => ({ id: t.id, focus: t.focus, status: t.status() })))),
      ),
      HttpRouter.route(
        "GET",
        "/threads/:id/rlms/:rlm",
        Effect.gen(function* () {
          const { id, rlm } = yield* HttpRouter.params
          const thread = decodeURIComponent(id ?? "")
          // The id names a file: nothing but a thread id reaches the path.
          if (!THREAD_ID.test(thread)) return error(400, "invalid thread id")
          return HttpServerResponse.jsonUnsafe(log.history(thread, decodeURIComponent(rlm ?? "")))
        }),
      ),
      HttpRouter.route(
        "POST",
        "/threads/:id/stop",
        Effect.gen(function* () {
          const { id } = yield* HttpRouter.params
          const t = threads.list().find((x) => x.id === id)
          if (t === undefined) return error(404, "no such thread")
          yield* t.stop
          return HttpServerResponse.jsonUnsafe({ stopped: t.id })
        }),
      ),
    ]
  }),
)

/**
 * Core's HTTP API, as router layers. Needs `Threads`, `Log` and `Token`.
 *   POST /runs                 AG-UI RunAgentInput → SSE of the run's events
 *   GET  /stream?since=<seq>   every thread's events after seq, then live (SSE)
 *   GET  /threads              [{ id, focus, status }]
 *   POST /threads/:id/stop     stop the thread's current work
 *   GET  /threads/:id/rlms/:rlm  one agent's transcript lines (redacted), since it last started
 */
export const api = Layer.mergeAll(routes, auth)
