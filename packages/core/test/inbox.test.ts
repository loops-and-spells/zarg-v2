import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { makeLog } from "../src/log"
import { makeInbox } from "../src/inbox"
import { dirs, setup } from "./inbox-helper"

const grant = { kind: "grant", title: "backlog wants to write .zarg/triage", why: "fs write", answers: [{ id: "once", label: "Allow once" }, { id: "deny", label: "Deny", reason: "optional" as const }] }
const from = { plugin: "backlog" }

describe("the inbox", () => {
  test("ask blocks until answered; the answer resolves it; the topic is saved and logged", async () => {
    const { inbox, events, d } = await setup()
    const f = Effect.runFork(inbox.ask(from, { ...grant, blocking: true }))
    await Bun.sleep(5)
    const t = inbox.list()[0]!
    expect([t.state, t.blocking, t.from.plugin]).toEqual(["open", true, "backlog"])
    expect(existsSync(join(d.dir, `${t.id}.json`))).toBe(true)
    expect(await Effect.runPromise(inbox.answer(t.id, { answer: "once" }))).toEqual({ ok: true, notice: "answered" })
    expect(await Effect.runPromise(Fiber.join(f))).toEqual({ answer: "once" })
    expect(events().map((e) => e.state)).toEqual(["open", "answered"])
  })
  test("an answer to a topic that is not open, an answer it does not offer, or a missing required reason is refused", async () => {
    const { inbox } = await setup()
    const id = await Effect.runPromise(inbox.post(from, { ...grant, answers: [{ id: "no", label: "No", reason: "required" }, { id: "yes", label: "Yes" }] }))
    expect((await Effect.runPromise(inbox.answer(id, { answer: "maybe" }))).ok).toBe(false)
    expect((await Effect.runPromise(inbox.answer(id, { answer: "no" }))).ok).toBe(false)
    expect((await Effect.runPromise(inbox.answer(id, { answer: "no", text: "wrong scenario" }))).ok).toBe(true)
    expect(await Effect.runPromise(inbox.answer(id, { answer: "yes" }))).toEqual({ ok: false, notice: "that topic is answered" })
  })
  test("a posted topic's answer goes to the plugin's answered; the same key updates, not duplicates", async () => {
    const { inbox, answered } = await setup()
    const a = await Effect.runPromise(inbox.post(from, { ...grant, key: "B-12" }))
    const b = await Effect.runPromise(inbox.post(from, { ...grant, key: "B-12", title: "again" }))
    expect(b).toBe(a)
    expect(inbox.list().map((t) => t.title)).toEqual(["again"])
    await Effect.runPromise(inbox.answer(a, { answer: "once" }))
    // The plugin hears of it in the background.
    await Bun.sleep(5)
    expect(answered).toEqual([[a, { answer: "once" }]])
  })
  test("batch: same kind, all offering the answer; else nothing is applied", async () => {
    const { inbox } = await setup()
    const a = await Effect.runPromise(inbox.post(from, grant))
    const b = await Effect.runPromise(inbox.post(from, grant))
    const c = await Effect.runPromise(inbox.post(from, { ...grant, kind: "drift" }))
    expect((await Effect.runPromise(inbox.answerMany([a, c], { answer: "once" }))).ok).toBe(false)
    expect(inbox.list().filter((t) => t.state === "answered")).toEqual([])
    expect(await Effect.runPromise(inbox.answerMany([a, b], { answer: "once" }))).toEqual({ ok: true, notice: "2 answered" })
  })
  test("snooze: refused on a blocking topic; a snoozed topic wakes on update", async () => {
    const { inbox } = await setup()
    Effect.runFork(inbox.ask(from, { ...grant, blocking: true }))
    await Bun.sleep(5)
    const blocking = inbox.list()[0]!.id
    expect((await Effect.runPromise(inbox.snooze(blocking))).ok).toBe(false)
    const id = await Effect.runPromise(inbox.post(from, grant))
    await Effect.runPromise(inbox.snooze(id))
    expect(inbox.list().find((t) => t.id === id)?.snoozed).toEqual({ until: "change" })
    await Effect.runPromise(inbox.update("backlog", id, { evidence: "new" }))
    expect(inbox.list().find((t) => t.id === id)?.snoozed).toBeUndefined()
  })
  test("settle makes a topic moot with the reason; another plugin cannot settle it; an interrupted ask leaves a moot topic", async () => {
    const { inbox } = await setup()
    const id = await Effect.runPromise(inbox.post(from, grant))
    expect((await Effect.runPromise(inbox.settle("triage", id, "no"))).notice).toBe("not triage's topic")
    await Effect.runPromise(inbox.settle("backlog", id, "the plan was dropped"))
    expect(inbox.list().find((t) => t.id === id)).toMatchObject({ state: "moot", moot: "the plan was dropped" })
    const f = Effect.runFork(inbox.ask(from, { ...grant, blocking: true }))
    await Bun.sleep(5)
    await Effect.runPromise(Fiber.interrupt(f))
    expect(inbox.list().find((t) => t.blocking)).toMatchObject({ state: "moot", moot: "the asker stopped" })
  })
  test("on start: topics load; open blocking topics from a previous core become moot; closed ones older than 7 days go; a corrupt file is skipped", async () => {
    const d = dirs()
    let now = 1000
    const first = await setup(d, () => now)
    Effect.runFork(first.inbox.ask(from, { ...grant, blocking: true }))
    const kept = await Effect.runPromise(first.inbox.post(from, grant))
    const old = await Effect.runPromise(first.inbox.post(from, { kind: "report", title: "run done", why: "run" }))
    await Effect.runPromise(first.inbox.read(old))
    await Bun.sleep(5)
    writeFileSync(join(d.dir, "T-broken.json"), "{")
    now = 1000 + 8 * 24 * 3600 * 1000
    const second = await setup(d, () => now)
    const byId = new Map(second.inbox.list().map((t) => [t.id, t]))
    expect(byId.get(kept)?.state).toBe("open")
    expect(byId.has(old)).toBe(false)
    expect([...byId.values()].find((t) => t.blocking)).toMatchObject({ state: "moot", moot: "zarg restarted before it was answered" })
    expect(readdirSync(d.dir)).not.toContain(`${old}.json`)
    // The corrupt file is reported once, as a report from zarg.
    expect([...byId.values()].filter((t) => t.kind === "report" && t.title === "Inbox file T-broken.json is not a topic").length).toBe(1)
  })
  test("a plugin cannot choose a topic's id, owner or state: update and post take only topic fields", async () => {
    const { inbox, d } = await setup()
    const victim = await Effect.runPromise(inbox.post({ plugin: "v" }, grant))
    const mine = await Effect.runPromise(inbox.post(from, { ...grant, key: "k" }))
    await Effect.runPromise(inbox.update("backlog", mine, { id: victim, from: { plugin: "v" }, state: "open", title: "hijacked" } as never))
    await Effect.runPromise(inbox.update("backlog", mine, { id: "../escaped" } as never))
    await Effect.runPromise(inbox.post(from, { ...grant, key: "k", id: victim, blocking: true, state: "answered" } as never))
    expect(inbox.list().find((t) => t.id === victim)).toMatchObject({ title: grant.title, from: { plugin: "v" } })
    expect(inbox.list().find((t) => t.id === mine)).toMatchObject({ from: { plugin: "backlog" }, state: "open", blocking: false })
    expect(existsSync(join(d.dir, "..", "escaped.json"))).toBe(false)
  })
  test("a batch answers each topic once", async () => {
    const { inbox, answered } = await setup()
    const a = await Effect.runPromise(inbox.post(from, grant))
    expect(await Effect.runPromise(inbox.answerMany([a, a], { answer: "once" }))).toEqual({ ok: true, notice: "1 answered" })
    await Bun.sleep(5)
    expect(answered.length).toBe(1)
  })
  test("the answer does not wait for the plugin's answered", async () => {
    const d = dirs()
    const log = await Effect.runPromise(makeLog(d.log, (t) => t))
    const inbox = await Effect.runPromise(makeInbox({ log, dir: d.dir, answered: () => Effect.sleep("2 seconds") }))
    const id = await Effect.runPromise(inbox.post(from, grant))
    const t0 = Date.now()
    await Effect.runPromise(inbox.answer(id, { answer: "once" }))
    expect(Date.now() - t0).toBeLessThan(500)
  })
  test("a plugin that exits leaves its waiting asks moot", async () => {
    const { inbox } = await setup()
    const f = Effect.runFork(Effect.exit(inbox.ask(from, { ...grant, blocking: true })))
    await Bun.sleep(5)
    await Effect.runPromise(inbox.stopped("backlog"))
    expect(inbox.list()[0]).toMatchObject({ state: "moot", moot: "backlog stopped" })
    expect((await Effect.runPromise(Fiber.join(f)))._tag).toBe("Failure")
  })
  test("an empty batch is refused; posting again by key wakes a snoozed topic; the same post twice logs once", async () => {
    const { inbox, events } = await setup()
    expect((await Effect.runPromise(inbox.answerMany([], { answer: "once" }))).ok).toBe(false)
    const id = await Effect.runPromise(inbox.post(from, { ...grant, key: "k" }))
    await Effect.runPromise(inbox.snooze(id))
    await Effect.runPromise(inbox.post(from, { ...grant, key: "k", evidence: "new" }))
    expect(inbox.list()[0]!.snoozed).toBeUndefined()
    const n = events().length
    await Effect.runPromise(inbox.post(from, { ...grant, key: "k", evidence: "new" }))
    expect(events().length).toBe(n)
  })
  test("on start only open topics are logged again (closed ones are in the log already)", async () => {
    const d = dirs()
    const first = await setup(d)
    const open = await Effect.runPromise(first.inbox.post(from, grant))
    const closed = await Effect.runPromise(first.inbox.post(from, grant))
    await Effect.runPromise(first.inbox.answer(closed, { answer: "once" }))
    const second = await setup({ ...d, log: dirs().log })
    expect(second.events().map((e) => e.id)).toEqual([open])
  })
  test("the inbox keeps itself out of the project's repository (a * .gitignore inside)", async () => {
    const { d } = await setup()
    expect(readFileSync(join(d.dir, ".gitignore"), "utf8")).toBe("*\n")
  })
  test("zarg's questions: raised (blocking, durable) survive a restart; answers and replies go to their owner, and a reply is kept as a message", async () => {
    const d = dirs()
    const seen: Array<unknown> = []
    const log = await Effect.runPromise(makeLog(d.log, (t) => t))
    const opts = { log, dir: d.dir, answered: (t: { id: string }, r: unknown) => Effect.sync(() => void seen.push(["answered", t.id, r])), replied: (t: { id: string }, text: string) => Effect.sync(() => void seen.push(["replied", t.id, text])) }
    const first = await Effect.runPromise(makeInbox(opts))
    const id = await Effect.runPromise(first.raise({ plugin: "zarg", agent: "zarg" }, { kind: "question", title: "Which scenario first?", why: "zarg asks", answers: [{ id: "a", label: "Checkout" }] }, { blocking: true, durable: true }))
    const second = await Effect.runPromise(makeInbox(opts))
    expect(second.list().find((t) => t.id === id)).toMatchObject({ state: "open", blocking: true, durable: true })
    expect(await Effect.runPromise(second.reply(id, "why Checkout?"))).toEqual({ ok: true, notice: "sent" })
    expect(second.list().find((t) => t.id === id)!.messages.map((m) => [m.by, m.text])).toEqual([["you", "why Checkout?"]])
    await Effect.runPromise(second.answer(id, { answer: "a" }))
    await Bun.sleep(5)
    expect(seen).toEqual([["replied", id, "why Checkout?"], ["answered", id, { answer: "a" }]])
    expect((await Effect.runPromise(second.reply(id, "late"))).ok).toBe(false)
  })
})
