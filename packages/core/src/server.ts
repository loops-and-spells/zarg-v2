import type { InboxService } from "./inbox"
import { Context, type Duration, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RunAgentInputSchema } from "@ag-ui/core/schemas"
import type { WireEvent } from "./events"
import type { ThreadLog } from "./log"
import type { Thread } from "@zarg/agent-host"

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

/** What `/reconcile` did: on (with how many scenarios are pending), or why reconcile stays off. */
export interface ReconcileAnswer {
  readonly on: boolean
  readonly reason?: string
  readonly pending?: number
}

/** Turn plan and implement on for this session (`POST /reconcile`), even when the config leaves them off. */
export class ReconcileControl extends Context.Service<ReconcileControl, { readonly turnOn: Effect.Effect<ReconcileAnswer> }>()("@zarg/core/ReconcileControl") {}

/** First-run setup: \`POST /setup/open\` opens the Setup view (absent in cores and tests without it). */
export class SetupControl extends Context.Service<SetupControl, { readonly open: (at?: "providers" | "models") => Effect.Effect<void> }>()("@zarg/core/SetupControl") {}

/** Slash commands plugins add (`GET /commands`, `POST /plugins/:name/commands/:cmd`). */
export class PluginCommands extends Context.Service<
  PluginCommands,
  {
    readonly list: () => ReadonlyArray<{ readonly plugin: string; readonly cmd: string; readonly desc: string; readonly method: string; readonly arg: unknown }>
    readonly run: (plugin: string, cmd: string, args: ReadonlyArray<string>) => Effect.Effect<{ readonly notice: string }>
  }
>()("@zarg/core/PluginCommands") {}

/** Actions on rows of an agent's view (`POST …/actions/:action`). */
export class Actions extends Context.Service<
  Actions,
  {
    readonly act: (thread: string, agent: string, action: string, section: string | undefined, rows: ReadonlyArray<string>, view?: string, text?: string) => Effect.Effect<{ readonly notice: string }>
    readonly answer: (thread: string, agent: string, question: string, answer: { readonly choice?: string; readonly other?: string }) => Effect.Effect<{ readonly notice: string }>
    readonly message: (thread: string, agent: string, text: string) => Effect.Effect<{ readonly notice: string }>
  }
>()("@zarg/core/Actions") {}

/** Answers to the core's own prompts (grant popovers): `POST /prompts/:id`. */
export class Prompts extends Context.Service<Prompts, {
  readonly answer: (id: string, answer: { readonly choice: string }) => Effect.Effect<{ readonly notice: string }>
  /** Close a plugin's popover (Esc). */
  readonly close: (id: string) => Effect.Effect<{ readonly notice: string }>
}>()("@zarg/core/Prompts") {}

/** The operator's inbox: answers, batches, snooze, read (`POST /inbox/...`). */
export class InboxControl extends Context.Service<InboxControl, InboxService>()("@zarg/core/InboxControl") {}

/** Archive, restore or delete agents of a thread's tree (`POST /threads/:id/archive`). */
export class ArchiveControl extends Context.Service<ArchiveControl, {
  readonly apply: (thread: string, change: { readonly archive?: ReadonlyArray<string>; readonly restore?: ReadonlyArray<string>; readonly delete?: ReadonlyArray<string> }) => Effect.Effect<{ readonly notice: string }>
}>()("@zarg/core/ArchiveControl") {}

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
    const actions = yield* Actions
    const commands = yield* PluginCommands
    const prompts = yield* Prompts
    const inbox = yield* InboxControl
    const archive = yield* ArchiveControl
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
        "/setup/open",
        Effect.gen(function* () {
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { at?: unknown }
          const setup = yield* Effect.serviceOption(SetupControl)
          if (setup._tag === "None") return error(404, "this core has no setup")
          yield* setup.value.open(body.at === "models" ? "models" : "providers")
          return HttpServerResponse.jsonUnsafe({ notice: "opened" })
        }),
      ),
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
        "POST",
        "/prompts/:id",
        Effect.gen(function* () {
          const { id } = yield* HttpRouter.params
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { choice?: unknown; close?: unknown }
          if (body.close === true) return HttpServerResponse.jsonUnsafe(yield* prompts.close(decodeURIComponent(id ?? "")))
          if (typeof body.choice !== "string") return error(400, `an answer needs { "choice" } or { "close": true }`)
          return HttpServerResponse.jsonUnsafe(yield* prompts.answer(decodeURIComponent(id ?? ""), { choice: body.choice }))
        }),
      ),
      HttpRouter.route(
        "POST",
        "/inbox/answer",
        Effect.gen(function* () {
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { ids?: unknown; answer?: unknown; text?: unknown }
          if (!Array.isArray(body.ids) || typeof body.answer !== "string") return error(400, `a batch needs { "ids", "answer" }`)
          const r = yield* inbox.answerMany(body.ids.map(String), { answer: body.answer, ...(typeof body.text === "string" ? { text: body.text } : {}) })
          return HttpServerResponse.jsonUnsafe({ notice: r.notice }, { status: r.ok ? 200 : 409 })
        }),
      ),
      HttpRouter.route(
        "POST",
        "/inbox/:id/:op",
        Effect.gen(function* () {
          const { id, op } = yield* HttpRouter.params
          const topic = decodeURIComponent(id ?? "")
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { answer?: unknown; text?: unknown }
          const r =
            op === "answer"
              ? yield* inbox.answer(topic, { ...(typeof body.answer === "string" ? { answer: body.answer } : {}), ...(typeof body.text === "string" ? { text: body.text } : {}) })
              : op === "snooze"
                ? yield* inbox.snooze(topic)
                : op === "read"
                  ? yield* inbox.read(topic)
                  : op === "reply"
                    ? yield* inbox.reply(topic, typeof body.text === "string" ? body.text : "")
                  : { ok: false, notice: `unknown inbox action ${op}` }
          return HttpServerResponse.jsonUnsafe({ notice: r.notice }, { status: r.ok ? 200 : 409 })
        }),
      ),
      HttpRouter.route("GET", "/commands", Effect.sync(() => HttpServerResponse.jsonUnsafe(commands.list()))),
      HttpRouter.route(
        "POST",
        "/plugins/:name/commands/:cmd",
        Effect.gen(function* () {
          const { name, cmd } = yield* HttpRouter.params
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { args?: unknown }
          if (!Array.isArray(body.args) || !body.args.every((a) => typeof a === "string")) return error(400, `a command needs { "args": [strings] }`)
          return HttpServerResponse.jsonUnsafe(yield* commands.run(decodeURIComponent(name ?? ""), `/${decodeURIComponent(cmd ?? "")}`, body.args as ReadonlyArray<string>))
        }),
      ),
      HttpRouter.route(
        "POST",
        "/threads/:id/agents/:agent/answers",
        Effect.gen(function* () {
          const { id, agent } = yield* HttpRouter.params
          const thread = decodeURIComponent(id ?? "")
          if (!THREAD_ID.test(thread)) return error(400, "invalid thread id")
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { question?: unknown; answer?: { choice?: unknown; other?: unknown } }
          const a = body.answer
          if (typeof body.question !== "string" || a === undefined || (typeof a.choice !== "string" && typeof a.other !== "string")) return error(400, `an answer needs { "question": id, "answer": { "choice" } or { "other" } }`)
          const answer = typeof a.choice === "string" ? { choice: a.choice } : { other: String(a.other) }
          return HttpServerResponse.jsonUnsafe(yield* actions.answer(thread, decodeURIComponent(agent ?? ""), body.question, answer))
        }),
      ),
      HttpRouter.route(
        "POST",
        "/threads/:id/agents/:agent/messages",
        Effect.gen(function* () {
          const { id, agent } = yield* HttpRouter.params
          const thread = decodeURIComponent(id ?? "")
          if (!THREAD_ID.test(thread)) return error(400, "invalid thread id")
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { text?: unknown }
          if (typeof body.text !== "string" || body.text.trim().length === 0) return error(400, `a message needs { "text" }`)
          return HttpServerResponse.jsonUnsafe(yield* actions.message(thread, decodeURIComponent(agent ?? ""), body.text))
        }),
      ),
      HttpRouter.route(
        "POST",
        "/threads/:id/agents/:agent/actions/:action",
        Effect.gen(function* () {
          const { id, agent, action } = yield* HttpRouter.params
          const thread = decodeURIComponent(id ?? "")
          if (!THREAD_ID.test(thread)) return error(400, "invalid thread id")
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { section?: unknown; rows?: unknown; view?: unknown; text?: unknown }
          if (!Array.isArray(body.rows) || !body.rows.every((r) => typeof r === "string")) return error(400, `an action needs { "rows": [ids] }`)
          if (body.section !== undefined && typeof body.section !== "string") return error(400, `an action's "section" must be a string`)
          if (body.view !== undefined && typeof body.view !== "string") return error(400, `an action's "view" must be a string`)
          if (body.text !== undefined && typeof body.text !== "string") return error(400, `an action's "text" must be a string`)
          return HttpServerResponse.jsonUnsafe(yield* actions.act(thread, decodeURIComponent(agent ?? ""), decodeURIComponent(action ?? ""), body.section as string | undefined, body.rows as ReadonlyArray<string>, body.view as string | undefined, body.text as string | undefined))
        }),
      ),
      HttpRouter.route(
        "POST",
        "/threads/:id/archive",
        Effect.gen(function* () {
          const { id } = yield* HttpRouter.params
          const thread = decodeURIComponent(id ?? "")
          if (!THREAD_ID.test(thread)) return error(400, "invalid thread id")
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
          const ids = (k: string) => (Array.isArray(body[k]) && (body[k] as Array<unknown>).every((x) => typeof x === "string") ? (body[k] as ReadonlyArray<string>) : undefined)
          const change = { ...(ids("archive") ? { archive: ids("archive")! } : {}), ...(ids("restore") ? { restore: ids("restore")! } : {}), ...(ids("delete") ? { delete: ids("delete")! } : {}) }
          if (Object.keys(change).length === 0) return error(400, `archive needs { "archive" | "restore" | "delete": [agent ids] }`)
          return HttpServerResponse.jsonUnsafe(yield* archive.apply(thread, change))
        }),
      ),
      // @scenario S-0044
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
 *   GET  /commands              slash commands plugins add
 *   POST /plugins/:name/commands/:cmd  { args } → { notice }
 *   POST /threads/:id/agents/:agent/actions/:action  { rows } → { notice }
 *   POST /threads/:id/archive  { archive | restore | delete: [ids] } → { notice }
 *   POST /prompts/:id          { choice } → { notice } (a grant popover's answer); { close: true } closes a plugin's popover
 *   POST /inbox/:id/answer     { answer?, text? } → { notice } (409 when the topic is not open or the answer is refused)
 *   POST /inbox/answer         { ids, answer, text? } → { notice } (a batch: one kind, all offering the answer)
 *   POST /inbox/:id/snooze     → { notice } (not a blocking topic); POST /inbox/:id/read → { notice } (a report)
 *   POST /inbox/:id/reply      { text } → { notice } (talk a topic over: its owner hears it)
 */
export const api = Layer.mergeAll(routes, auth)
