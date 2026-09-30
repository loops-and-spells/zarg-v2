import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
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
    expect((await Effect.runPromise(inbox.answer(id, { answer: "no", text: "wrong card" }))).ok).toBe(true)
    expect(await Effect.runPromise(inbox.answer(id, { answer: "yes" }))).toEqual({ ok: false, notice: "that topic is answered" })
  })
  test("a posted topic's answer goes to the plugin's answered; the same key updates, not duplicates", async () => {
    const { inbox, answered } = await setup()
    const a = await Effect.runPromise(inbox.post(from, { ...grant, key: "B-12" }))
    const b = await Effect.runPromise(inbox.post(from, { ...grant, key: "B-12", title: "again" }))
    expect(b).toBe(a)
    expect(inbox.list().map((t) => t.title)).toEqual(["again"])
    await Effect.runPromise(inbox.answer(a, { answer: "once" }))
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
})
