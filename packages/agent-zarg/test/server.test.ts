import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Duration, Effect, Layer, Stream } from "effect"
import { EventSchemas } from "@ag-ui/core/schemas"
import { Model, type ChatMessage, type StreamEvent } from "@zarg/model"
import { type Asker, inquire, Rlm, settings } from "@zarg/rlm"
import { HttpRouter } from "effect/unstable/http"
import { Actions, api, Heartbeat, PluginCommands, Prompts, Log, makeLog, makeThreads, ReconcileControl, Threads, Token, YoloControl } from "@zarg/core"
import { makeThread } from "../src/thread"

/** A stub model: the driver asks one question, then finishes with the answer. */
const stub = Layer.succeed(Model.Model, {
  client: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  info: () => Effect.die("unused"),
  warm: () => Effect.void,
  stream: (req) => {
    const toolResults = req.messages.filter((m: ChatMessage) => m.role === "tool").length
    const code =
      toolResults === 0
        ? 'const a = yield* Inquire.ask({ question: "Which card first?", options: [{ id: "a", label: "Checkout", recommended: true, why: "most used" }, { id: "b", label: "Login" }] })\nreturn a'
        : 'yield* Rlm.done({ value: "Working on the checkout card." })'
    const events: ReadonlyArray<StreamEvent> = [
      { type: "toolCall", call: { id: `c${toolResults}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } } },
      { type: "done", finishReason: "tool_calls" },
    ]
    return Stream.fromIterable(events)
  },
})

const TOKEN = "t0ken"
const yolos: Array<{ on: boolean; plugin?: string }> = []
/** The router as a fetch handler, over a real Rlm on the stub model (disposed after each test). */
const handlers: Array<{ dispose: () => Promise<void> }> = []
afterEach(() => Promise.all(handlers.splice(0).map((h) => h.dispose())))
const handler = async (heartbeat: Duration.Input = "5 seconds") => {
  const { threads, log } = await Effect.runPromise(
    Effect.gen(function* () {
      const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-srv-")), (t) => t)
      const model = yield* Model.Model
      const s = yield* settings({ presets: { driver: { layer: ["Inquire", "Rlm"], role: "driver", result: "text", verify: "none" } } })
      const makeRlm = (asker: Asker, observe: (e: Rlm.RlmEvent) => void) =>
        Rlm.make({ settings: s, services: (n) => (n === "Inquire" ? inquire(asker) : undefined), roles: { driver: "stub:m" }, observe }).pipe(Effect.provideService(Model.Model, model))
      const threads = yield* makeThreads({
        makeThread: (id, focus) => makeThread({ id, focus, log, agenda: () => Effect.succeed([]), driver: (spec, asker, observe) => Effect.flatMap(makeRlm(asker, observe), (rlm) => rlm.exec(spec)) }),
      })
      return { threads, log }
    }).pipe(Effect.provide(stub)),
  )
  const web = HttpRouter.toWebHandler(
    api.pipe(Layer.provide([Layer.succeed(Threads, threads), Layer.succeed(Log, log), Layer.succeed(Token, TOKEN), Layer.succeed(Heartbeat, heartbeat), Layer.succeed(ReconcileControl, { turnOn: Effect.succeed({ on: true, pending: 3 }) }), Layer.succeed(PluginCommands, { list: () => [{ plugin: "p", cmd: "/p-go", desc: "d", method: "command", arg: { kind: "none" } }], run: (plugin, cmd, args) => Effect.succeed({ notice: `${plugin} ${cmd} ${args.join(" ")}` }) }), Layer.succeed(Actions, { act: (_t, a, action, section, rows) => Effect.succeed({ notice: `${a} ${action} ${section ?? "-"} ${rows.join(",")}` }), answer: (_t, a, q, ans) => Effect.succeed({ notice: `${a} ${q} ${ans.choice ?? ans.other}` }), message: (_t, a, text) => Effect.succeed({ notice: `${a} ${text}` }) }), Layer.succeed(Prompts, { answer: (id, a) => Effect.succeed({ notice: `${id} ${a.choice}` }) }), Layer.succeed(YoloControl, { set: (on, plugin) => Effect.sync(() => (yolos.push({ on, ...(plugin !== undefined ? { plugin } : {}) }), { on })) })])),
    { disableLogger: true },
  )
  handlers.push(web)
  return (req: Request) => web.handler(req)
}

const post = (h: (r: Request) => Promise<Response>, path: string, body: unknown, token = TOKEN) =>
  h(new Request(`http://core${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }))

/** Read an SSE response into events, stopping at `limit` events (live streams never end on their own). */
const events = async (res: Response, limit = Infinity) => {
  const out: Array<any> = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  while (out.length < limit) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf("\n\n")) !== -1 && out.length < limit) {
      out.push(JSON.parse(buf.slice(6, i)))
      buf = buf.slice(i + 2)
    }
  }
  await reader.cancel().catch(() => {})
  return out
}

const input = (runId: string, extra: Record<string, unknown> = {}) => ({ threadId: "main", runId, state: {}, messages: [], tools: [], context: [], forwardedProps: {}, ...extra })

describe("core HTTP API", () => {
  test("requests without the token are refused", async () => {
    const h = await handler()
    expect((await post(h, "/runs", input("r1"), "wrong")).status).toBe(401)
  })

  test("a thread id that is not a plain name is a 400 (it names a log file)", async () => {
    const h = await handler()
    for (const threadId of ["../escape", "feature/x", ""]) expect((await post(h, "/runs", input("r1", { threadId }))).status).toBe(400)
  })

  test("an invalid RunAgentInput is a 400", async () => {
    const h = await handler()
    expect((await post(h, "/runs", { threadId: "main" })).status).toBe(400)
  })

  test("a run streams AG-UI events and ends with the driver's inquiry as an interrupt; resume continues", async () => {
    const h = await handler()
    const first = await events(await post(h, "/runs", input("r1")))
    const finished = first.at(-1)
    expect(finished).toMatchObject({ type: "RUN_FINISHED", runId: "r1", outcome: { type: "interrupt" } })
    const interrupt = finished.outcome.interrupts[0]
    expect(interrupt).toMatchObject({ reason: "inquiry", message: "Which card first?", metadata: { options: [{ id: "a", recommended: true }, { id: "b" }] } })
    const second = await events(await post(h, "/runs", input("r2", { resume: [{ interruptId: interrupt.id, status: "resolved", payload: { choice: "a" } }] })), 12)
    const texts = second.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)
    expect(texts).toEqual(["Checkout", "Working on the checkout card."])
  })

  test("a client that disconnects mid-run does not stop the thread; the next run gets the inquiry", async () => {
    const h = await handler()
    await events(await post(h, "/runs", input("r1")), 1)
    const again = await events(await post(h, "/runs", input("r2")))
    expect(again.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt" } })
  })

  test("a quiet event stream carries heartbeat comments, so idle timeouts never cut it", async () => {
    const h = await handler("50 millis")
    // From the thread's newest event (zarg's row is already there): nothing new, so only heartbeats.
    const res = await h(new Request("http://core/stream?since=1", { headers: { authorization: `Bearer ${TOKEN}` } }))
    const reader = res.body!.getReader()
    const first = await Promise.race([reader.read(), Bun.sleep(1000).then(() => undefined)])
    await reader.cancel()
    expect(new TextDecoder().decode(first?.value)).toBe(": ping\n\n")
  })

  test("every event is valid AG-UI 1.0", async () => {
    const h = await handler()
    const all = await events(await post(h, "/runs", input("r1")))
    for (const e of all) {
      const r = EventSchemas.safeParse(e)
      if (!r.success) throw new Error(`${e.type}: ${r.error.message}`)
    }
    expect(all.map((e) => e.type)).toContain("ACTIVITY_DELTA")
  })

  test("/stream replays events after a sequence number", async () => {
    const h = await handler()
    const run = await events(await post(h, "/runs", input("r1")))
    const since = run[1].seq
    const replay = await events(await h(new Request(`http://core/stream?since=${since}`, { headers: { authorization: `Bearer ${TOKEN}` } })), run.length - 2)
    expect(replay.map((e) => e.seq)).toEqual(run.slice(2).map((e) => e.seq))
  })

  test("POST /yolo turns YOLO on or off (for all plugins or one) and answers the state", async () => {
    const h = await handler()
    expect(await (await post(h, "/yolo", { on: true })).json()).toEqual({ on: true })
    expect(await (await post(h, "/yolo", { on: false, plugin: "tracker" })).json()).toEqual({ on: false })
    expect((await post(h, "/yolo", { on: "yes" })).status).toBe(400)
    expect((await post(h, "/yolo", { on: true }, "wrong")).status).toBe(401)
    expect(yolos).toEqual([{ on: true }, { on: false, plugin: "tracker" }])
  })

  test("POST /reconcile turns reconcile on and answers what happens", async () => {
    const h = await handler()
    expect(await (await post(h, "/reconcile", {})).json()).toEqual({ on: true, pending: 3 })
    expect((await post(h, "/reconcile", {}, "wrong")).status).toBe(401)
  })

  test("an agent's actions; bodies are gone (views travel on the event stream)", async () => {
    const h = await handler()
    const get = (path: string) => h(new Request(`http://core${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }))
    expect((await get("/threads/main/agents/p%3Ax/body")).status).toBe(404)
    expect(await (await post(h, "/threads/main/agents/p%3Ax/actions/apply", { section: "review.findings", rows: ["R-1", "R-2"] })).json()).toEqual({ notice: "p:x apply review.findings R-1,R-2" })
    expect(await (await post(h, "/threads/main/agents/p%3Ax/actions/apply", { rows: ["R-1"] })).json()).toEqual({ notice: "p:x apply - R-1" })
    expect((await post(h, "/threads/main/agents/p%3Ax/actions/apply", { section: 3, rows: ["R-1"] })).status).toBe(400)
    expect((await post(h, "/threads/main/agents/p%3Ax/actions/apply", { rows: "nope" })).status).toBe(400)
  })

  test("answers and messages to a plugin agent's conversation", async () => {
    const h = await handler()
    expect(await (await post(h, "/threads/main/agents/p%3Ax/answers", { question: "q1", answer: { choice: "y" } })).json()).toEqual({ notice: "p:x q1 y" })
    expect((await post(h, "/threads/main/agents/p%3Ax/answers", { question: "q1", answer: {} })).status).toBe(400)
    expect(await (await post(h, "/threads/main/agents/p%3Ax/messages", { text: "hi" })).json()).toEqual({ notice: "p:x hi" })
    expect((await post(h, "/threads/main/agents/p%3Ax/messages", { text: " " })).status).toBe(400)
  })

  test("POST /prompts/:id answers one of the core's prompts (a grant popover)", async () => {
    const h = await handler()
    expect(await (await post(h, "/prompts/prompt-1", { choice: "once" })).json()).toEqual({ notice: "prompt-1 once" })
    expect((await post(h, "/prompts/prompt-1", {})).status).toBe(400)
  })

  test("plugin slash commands are listed and run", async () => {
    const h = await handler()
    expect(await (await h(new Request("http://core/commands", { headers: { authorization: `Bearer ${TOKEN}` } }))).json()).toEqual([{ plugin: "p", cmd: "/p-go", desc: "d", method: "command", arg: { kind: "none" } }])
    expect(await (await post(h, "/plugins/p/commands/p-go", { args: ["now"] })).json()).toEqual({ notice: "p /p-go now" })
    expect((await post(h, "/plugins/p/commands/p-go", { args: "now" })).status).toBe(400)
  })

  test("/threads lists threads; stop stops the current work", async () => {
    const h = await handler()
    await events(await post(h, "/runs", input("r1")))
    const list = await (await h(new Request("http://core/threads", { headers: { authorization: `Bearer ${TOKEN}` } }))).json()
    expect(list).toEqual([{ id: "main", focus: [], status: "waiting" }])
    const stopped = await post(h, "/threads/main/stop", {})
    expect(await stopped.json()).toEqual({ stopped: "main" })
  })
})
