import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { makeLog } from "../src/log"
import { makeInbox } from "../src/inbox"
import { Actions, api, ArchiveControl, Heartbeat, InboxControl, Log, PluginCommands, Prompts, ReconcileControl, Threads, Token, YoloControl } from "../src/server"

const handlers: Array<{ dispose: () => Promise<void> }> = []
afterEach(() => Promise.all(handlers.splice(0).map((h) => h.dispose())))
const grant = { kind: "grant", title: "backlog wants to write", why: "fs write", answers: [{ id: "once", label: "Allow once" }, { id: "deny", label: "Deny" }] }

const setup = async () => {
  const log = await Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-ir-log-")), (t) => t))
  const inbox = await Effect.runPromise(makeInbox({ log, dir: mkdtempSync(join(tmpdir(), "zarg-ir-")) }))
  const none = () => Effect.succeed({ notice: "" })
  const web = HttpRouter.toWebHandler(
    api.pipe(
      Layer.provide([
        Layer.succeed(InboxControl, inbox),
        Layer.succeed(Threads, { list: () => [], get: () => undefined } as never),
        Layer.succeed(Log, log),
        Layer.succeed(Token, "tok"),
        Layer.succeed(Heartbeat, "5 seconds"),
        Layer.succeed(ReconcileControl, { turnOn: Effect.succeed({ on: true, pending: 0 }) } as never),
        Layer.succeed(PluginCommands, { list: () => [], run: none } as never),
        Layer.succeed(Actions, { act: none, answer: none, message: none } as never),
        Layer.succeed(Prompts, { answer: none, close: none } as never),
        Layer.succeed(ArchiveControl, { apply: none } as never),
        Layer.succeed(YoloControl, { set: (on: boolean) => Effect.succeed({ on }) } as never),
      ]),
    ),
    { disableLogger: true },
  )
  handlers.push(web)
  const post = async (path: string, body: unknown) => {
    const res = await web.handler(new Request(`http://core${path}`, { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body) }))
    return [res.status, await res.json()] as const
  }
  return { inbox, post }
}

test("POST /inbox/:id/answer answers; a second answer is 409 with the topic's state; batch, snooze and read routes", async () => {
  const { inbox, post } = await setup()
  const from = { plugin: "backlog" }
  const id = await Effect.runPromise(inbox.post(from, grant))
  expect(await post(`/inbox/${id}/answer`, { answer: "once" })).toEqual([200, { notice: "answered" }])
  expect(await post(`/inbox/${id}/answer`, { answer: "once" })).toEqual([409, { notice: "that topic is answered" }])
  const a = await Effect.runPromise(inbox.post(from, grant))
  const b = await Effect.runPromise(inbox.post(from, grant))
  expect(await post("/inbox/answer", { ids: [a, b], answer: "once" })).toEqual([200, { notice: "2 answered" }])
  expect((await post("/inbox/answer", { answer: "once" }))[0]).toBe(400)
  const c = await Effect.runPromise(inbox.post(from, grant))
  expect(await post(`/inbox/${c}/snooze`, {})).toEqual([200, { notice: "snoozed until it changes" }])
  const r = await Effect.runPromise(inbox.post(from, { kind: "report", title: "done", why: "run" }))
  expect(await post(`/inbox/${r}/read`, {})).toEqual([200, { notice: "read" }])
})
