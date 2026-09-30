# Inbox Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator's home is a priority-sorted inbox of topics (questions, decisions, findings, reports). Plugins and the core raise topics through one API, and the operator answers them with numbers, reasons or batches.

**Architecture:**
- **Core:** a new `Inbox` service (`packages/core/src/inbox.ts`) keeps topics as files under `.zarg/inbox/` and logs each change as a `zarg.inbox` event on the `main` thread, as prompts do. It answers them through `POST /inbox/...` routes.
- **Plugins:** a new `Inbox` power, scope `inbox: true`, lets them `ask` (blocking), `post`, `settle` and `update`.
- **Client:** `@zarg/client` folds `zarg.inbox` events into `ThreadState.inbox` and sorts with `priorityOf`.
- **TUI:** `@zarg/view-tui` makes `Main = "inbox"` the home, with a list view and a topic view.
- **First source:** the host's disabled/failed/missing plugins.

**Tech Stack:** Bun, Effect 4, `effect/unstable/http`, OpenTUI React.

**Spec:** `docs/superpowers/specs/2026-09-29-inbox-core-design.md`. Mock frames 6 and 7: `docs/superpowers/specs/2026-09-29-decision-inbox-mock.md`.

## Global Constraints

- **Words:** a *topic* is an inbox item; "thread" stays the core's AG-UI run thread (`main`, `plan`, `implement`).
- **Blocking topics** never expire unless the asker passes a deadline, and they cannot be snoozed.
- **Priority** is computed in one place, `priorityOf(topic, now)` in `@zarg/client`, never by plugins.
- **Namespacing:** a plugin settles and updates only its own topics.
- **Storage:** `.zarg/inbox/` is gitignored. Answered, moot and read topics are dropped 7 days after their last update.
- **Package boundaries:** `@zarg/client` never imports `@zarg/core` or a `/server` subpath; `@zarg/view` imports no platform module.
- **Every commit:** `mise run build:plugins && mise run verify` passes first (it now includes `audit`). New code carries `// @card` tags only for cards that exist; new behaviour without a card needs no tag.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **An answer for a topic answered in another client a moment before:** a 409 with a notice, never a double resolve. Pinned in Task 1 ("an answer to a topic that is not open").
2. **A core restart while a plugin's `ask` is open:** the asker is gone, so its topic must become moot on load, never left open forever. Pinned in Task 1 ("open blocking topics from a previous core become moot").
3. **A batch whose topics don't all offer the answer:** refused as a whole, nothing half-applied. Pinned in Task 1.
4. **A plugin posting with another plugin's topic id, or settling it:** refused. Pinned in Task 3.
5. **Home on arrival with an empty inbox:** the view says "Nothing needs you", not a blank area. Pinned in Task 6.

---

### Task 1: The core's `Inbox` service

**Files:**
- Create: `packages/core/src/inbox.ts`
- Test: `packages/core/test/inbox.test.ts`
- Modify: `.gitignore` (add `.zarg/inbox/`)

**Interfaces:**
- Produces:
```ts
export const INBOX = "zarg.inbox"
export type Answer = { readonly id: string; readonly label: string; readonly recommended?: boolean; readonly why?: string; readonly reason?: "optional" | "required" }
export type TopicInput = {
  readonly kind: string; readonly title: string; readonly why: string
  readonly about?: ReadonlyArray<string>; readonly blocking?: boolean; readonly severity?: "high" | "medium" | "low"
  readonly answers?: ReadonlyArray<Answer>; readonly text?: { readonly placeholder: string }
  readonly evidence?: string; readonly origin?: { readonly view: string; readonly row?: string }
  readonly key?: string        // the asker's own stable key: posting the same key again updates that topic
}
export type Topic = TopicInput & {
  readonly id: string; readonly from: { readonly plugin: string; readonly agent?: string }
  readonly about: ReadonlyArray<string>; readonly blocking: boolean
  readonly messages: ReadonlyArray<{ readonly by: string; readonly at: number; readonly text: string }>
  readonly state: "open" | "answered" | "moot" | "read"
  readonly answer?: { readonly id?: string; readonly text?: string; readonly by: string; readonly at: number }
  readonly moot?: string; readonly snoozed?: { readonly until: "change" }
  readonly created: number; readonly updated: number
}
export type Reply = { readonly answer?: string; readonly text?: string }
export const makeInbox: (opts: { log: ThreadLog; dir: string; now?: () => number; answered?: (t: Topic, r: Reply) => Effect.Effect<void> }) => Effect.Effect<{
  ask: (from: Topic["from"], t: TopicInput) => Effect.Effect<Reply>           // blocking; interrupted → moot "the asker stopped"
  post: (from: Topic["from"], t: TopicInput) => Effect.Effect<string>         // returns the id; same `key` from the same plugin updates
  settle: (plugin: string, id: string, why: string) => Effect.Effect<{ notice: string }>
  update: (plugin: string, id: string, patch: Partial<TopicInput> & { message?: string }) => Effect.Effect<{ notice: string }>
  answer: (id: string, r: Reply, by?: string) => Effect.Effect<{ ok: boolean; notice: string }>
  answerMany: (ids: ReadonlyArray<string>, r: Reply, by?: string) => Effect.Effect<{ ok: boolean; notice: string }>
  snooze: (id: string) => Effect.Effect<{ ok: boolean; notice: string }>
  read: (id: string) => Effect.Effect<{ ok: boolean; notice: string }>
  list: () => ReadonlyArray<Topic>
}>
export type InboxService = Effect.Success<ReturnType<typeof makeInbox>>
```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/inbox.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { makeLog } from "../src/log"
import { INBOX, makeInbox } from "../src/inbox"

const dirs = () => ({ log: mkdtempSync(join(tmpdir(), "zarg-inbox-log-")), dir: mkdtempSync(join(tmpdir(), "zarg-inbox-")) })
const setup = async (d = dirs(), now = () => 1000, answered: Array<unknown> = []) => {
  const log = await Effect.runPromise(makeLog(d.log, (t) => t))
  const inbox = await Effect.runPromise(makeInbox({ log, dir: d.dir, now, answered: (t, r) => Effect.sync(() => void answered.push([t.id, r])) }))
  const events = () => log.all().filter((e) => e.type === "CUSTOM" && e.name === INBOX).map((e) => (e.value as { topic: { id: string; state: string } }).topic)
  return { inbox, log, events, d, answered }
}
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
```

- [ ] **Step 2: Run them to watch them fail**

Run: `cd packages/core && mise x -- bun test test/inbox.test.ts`. Expected: FAIL (`Cannot find module '../src/inbox'`).

- [ ] **Step 3: Implement `packages/core/src/inbox.ts`**

```ts
import { Deferred, Effect } from "effect"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as E from "./events"
import type { ThreadLog } from "./log"

export const INBOX = "zarg.inbox"
// (the Answer, TopicInput, Topic and Reply types exactly as in Interfaces)

const WEEK = 7 * 24 * 3600 * 1000
const newId = () => `T-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`

/** The operator's inbox: topics raised by plugins and the core, one file each, every change logged on main. */
export const makeInbox = (opts: { readonly log: ThreadLog; readonly dir: string; readonly now?: () => number; readonly answered?: (t: Topic, r: Reply) => Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const now = opts.now ?? Date.now
    mkdirSync(opts.dir, { recursive: true })
    const topics = new Map<string, Topic>()
    const waiting = new Map<string, Deferred.Deferred<Reply>>()
    const save = (t: Topic) =>
      Effect.gen(function* () {
        topics.set(t.id, t)
        const file = join(opts.dir, `${t.id}.json`)
        writeFileSync(`${file}.tmp`, `${JSON.stringify(t, null, 2)}\n`)
        renameSync(`${file}.tmp`, file)
        yield* Effect.ignore(opts.log.append("main", E.custom(INBOX, { topic: t })))
      })
    // Load: skip what is not a topic, drop closed ones older than a week, and moot blocking ones (their asker is gone).
    const corrupt: Array<string> = []
    for (const name of readdirSync(opts.dir).filter((n) => n.endsWith(".json"))) {
      let t: Topic | undefined
      try { t = JSON.parse(readFileSync(join(opts.dir, name), "utf8")) as Topic } catch { corrupt.push(name); continue }
      if (typeof t?.id !== "string" || typeof t.state !== "string") { corrupt.push(name); continue }
      if (t.state !== "open" && now() - t.updated > WEEK) { rmSync(join(opts.dir, name), { force: true }); continue }
      topics.set(t.id, t)
      if (t.state === "open" && t.blocking) yield* save({ ...t, state: "moot", moot: "zarg restarted before it was answered", updated: now() })
      else yield* Effect.ignore(opts.log.append("main", E.custom(INBOX, { topic: t })))
    }
    // A corrupt file is reported once (a report keyed by its name), and skipped.
    for (const name of corrupt) {
      const key = `corrupt:${name}`
      if (![...topics.values()].some((x) => x.key === key)) {
        const at = now()
        yield* save({ id: newId(), kind: "report", key, from: { plugin: "zarg" }, title: `Inbox file ${name} is not a topic`, why: "inbox", evidence: `zarg skips .zarg/inbox/${name}. Fix or remove it.`, about: [], blocking: false, messages: [], state: "open", created: at, updated: at })
      }
    }
    const make = (from: Topic["from"], t: TopicInput, blocking: boolean): Topic => ({ ...t, id: newId(), from, about: t.about ?? [], blocking, messages: [], state: "open", created: now(), updated: now() })
    const check = (t: Topic | undefined, r: Reply): string | undefined => {
      if (t === undefined) return "no such topic"
      if (t.state !== "open") return `that topic is ${t.state}`
      if (r.answer === undefined) return t.text !== undefined && (r.text ?? "").trim() !== "" ? undefined : "an answer is needed"
      const a = (t.answers ?? []).find((x) => x.id === r.answer)
      if (a === undefined) return `${r.answer} is not one of its answers`
      if (a.reason === "required" && (r.text ?? "").trim() === "") return `${a.label} needs a reason`
      return undefined
    }
    const settleOne = (t: Topic, r: Reply, by: string) =>
      Effect.gen(function* () {
        const done: Topic = { ...t, state: "answered", answer: { ...(r.answer !== undefined ? { id: r.answer } : {}), ...(r.text !== undefined ? { text: r.text } : {}), by, at: now() }, updated: now() }
        yield* save(done)
        const d = waiting.get(t.id)
        if (d !== undefined) { waiting.delete(t.id); yield* Deferred.succeed(d, r) }
        else if (opts.answered !== undefined) yield* Effect.ignore(opts.answered(done, r))
      })
    const mine = (plugin: string, id: string) => {
      const t = topics.get(id)
      return t === undefined ? { notice: "no such topic" } : t.from.plugin !== plugin ? { notice: `not ${plugin}'s topic` } : t
    }
    return {
      ask: (from: Topic["from"], input: TopicInput) =>
        Effect.gen(function* () {
          const t = make(from, input, true)
          const d = yield* Deferred.make<Reply>()
          waiting.set(t.id, d)
          yield* save(t)
          return yield* Deferred.await(d).pipe(
            Effect.onInterrupt(() =>
              Effect.suspend(() => {
                waiting.delete(t.id)
                const cur = topics.get(t.id)
                return cur?.state === "open" ? save({ ...cur, state: "moot", moot: "the asker stopped", updated: now() }) : Effect.void
              }),
            ),
          )
        }),
      post: (from: Topic["from"], input: TopicInput) =>
        Effect.gen(function* () {
          const same = input.key === undefined ? undefined : [...topics.values()].find((x) => x.from.plugin === from.plugin && x.key === input.key && x.state === "open")
          const t: Topic = same !== undefined ? { ...same, ...input, about: input.about ?? same.about, updated: now() } : make(from, input, false)
          yield* save(t)
          return t.id
        }),
      settle: (plugin: string, id: string, why: string) =>
        Effect.gen(function* () {
          const t = mine(plugin, id)
          if (!("id" in t)) return t
          if (t.state !== "open") return { notice: `that topic is ${t.state}` }
          yield* save({ ...t, state: "moot", moot: why, updated: now() })
          return { notice: "settled" }
        }),
      update: (plugin: string, id: string, patch: Partial<TopicInput> & { readonly message?: string }) =>
        Effect.gen(function* () {
          const t = mine(plugin, id)
          if (!("id" in t)) return t
          const { message, ...rest } = patch
          const { snoozed: _, ...woken } = t
          yield* save({ ...woken, ...rest, messages: message === undefined ? t.messages : [...t.messages, { by: plugin, at: now(), text: message }], updated: now() })
          return { notice: "updated" }
        }),
      answer: (id: string, r: Reply, by = "operator") =>
        Effect.gen(function* () {
          const t = topics.get(id)
          const why = check(t, r)
          if (why !== undefined) return { ok: false, notice: why }
          yield* settleOne(t!, r, by)
          return { ok: true, notice: "answered" }
        }),
      answerMany: (ids: ReadonlyArray<string>, r: Reply, by = "operator") =>
        Effect.gen(function* () {
          const ts = ids.map((id) => topics.get(id))
          const kinds = new Set(ts.map((t) => t?.kind))
          const why = kinds.size > 1 ? "a batch is one kind of topic" : ts.map((t) => check(t, r)).find((x) => x !== undefined)
          if (why !== undefined) return { ok: false, notice: why }
          for (const t of ts) yield* settleOne(t!, r, by)
          return { ok: true, notice: `${ts.length} answered` }
        }),
      snooze: (id: string) =>
        Effect.gen(function* () {
          const t = topics.get(id)
          if (t === undefined || t.state !== "open") return { ok: false, notice: "that topic is not open" }
          if (t.blocking) return { ok: false, notice: "something waits on it: it cannot be snoozed" }
          yield* save({ ...t, snoozed: { until: "change" }, updated: now() })
          return { ok: true, notice: "snoozed until it changes" }
        }),
      read: (id: string) =>
        Effect.gen(function* () {
          const t = topics.get(id)
          if (t === undefined || t.state !== "open" || (t.answers ?? []).length > 0 || t.blocking) return { ok: false, notice: "only reports are read" }
          yield* save({ ...t, state: "read", updated: now() })
          return { ok: true, notice: "read" }
        }),
      list: () => [...topics.values()],
    }
  })
export type InboxService = Effect.Success<ReturnType<typeof makeInbox>>
```
(Use the repo's own `E.custom` from `./events`, as `prompts.ts` does. If `ThreadLog.append` has a different arity, match `prompts.ts`.) Add `.zarg/inbox/` to the root `.gitignore`.

- [ ] **Step 4: Run the tests**

Run: `cd packages/core && mise x -- bun test test/inbox.test.ts && mise x -- bunx tsc`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/demiurge/Git/zarg-v2 && mise run build:plugins && mise run verify && git add .gitignore packages/core/src/inbox.ts packages/core/test/inbox.test.ts && git commit -m "feat(core): the inbox service: topics raised, answered, batched, snoozed, settled; one file each, logged on main

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 2: Routes, and the core wires the inbox

**Files:**
- Modify: `packages/core/src/server.ts` (a `InboxControl` service tag, 4 routes, the API doc block near line 267), `packages/core/src/live.ts` (build the inbox after the log; add it to the returned object), `packages/core/src/main.ts:50` (provide it)
- Test: `packages/core/test/inbox-routes.test.ts`

**Interfaces:**
- Consumes: `makeInbox`, `InboxService` (Task 1)
- Produces:
  - `POST /inbox/:id/answer {answer?, text?}` → 200 `{notice}` | 409 `{notice}`
  - `POST /inbox/answer {ids, answer, text?}` → 200 | 409
  - `POST /inbox/:id/snooze`, `POST /inbox/:id/read` → 200 | 409
  - `live` returns `inbox: InboxService`

- [ ] **Step 1: Write the failing test.** Read how an existing core test starts the HTTP API: `grep -ln "api\|HttpRouter\|/prompts" packages/core/test/*.ts`, and follow the file that posts to `/prompts/:id` (or `actions.test.ts`). Test:
```ts
test("POST /inbox/:id/answer answers; a second answer is 409 with the topic's state; batch and snooze routes", async () => {
  // start the API with a real makeInbox over temp dirs (as Task 1's setup), provided as InboxControl
  // const id = await Effect.runPromise(inbox.post({ plugin: "backlog" }, grant))
  // expect(await post(`/inbox/${id}/answer`, { answer: "once" })).toEqual([200, { notice: "answered" }])
  // expect(await post(`/inbox/${id}/answer`, { answer: "once" })).toEqual([409, { notice: "that topic is answered" }])
  // const [a, b] = two posts; expect(await post("/inbox/answer", { ids: [a, b], answer: "once" })).toEqual([200, { notice: "2 answered" }])
  // const c = post; expect((await post(`/inbox/${c}/snooze`, {}))[0]).toBe(200)
})
```
Write it in full with the harness that file uses (the `post` helper returns `[status, json]`).

- [ ] **Step 2: Run it.** Expected: FAIL (404 for `/inbox/...`).

- [ ] **Step 3: Implement.**

In `server.ts`:
```ts
/** The operator's inbox: answers, batches, snooze, read (`POST /inbox/...`). */
export class InboxControl extends Context.Service<InboxControl, InboxService>()("@zarg/core/InboxControl") {}
```
Inside `routes`, `const inbox = yield* InboxControl`, and add:
```ts
      HttpRouter.route("POST", "/inbox/answer", Effect.gen(function* () {
        const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { ids?: unknown; answer?: unknown; text?: unknown }
        if (!Array.isArray(body.ids) || typeof body.answer !== "string") return error(400, `a batch needs { "ids", "answer" }`)
        const r = yield* inbox.answerMany(body.ids.map(String), { answer: body.answer, ...(typeof body.text === "string" ? { text: body.text } : {}) })
        return HttpServerResponse.jsonUnsafe({ notice: r.notice }, { status: r.ok ? 200 : 409 })
      })),
      HttpRouter.route("POST", "/inbox/:id/:op", Effect.gen(function* () {
        const { id, op } = yield* HttpRouter.params
        const topic = decodeURIComponent(id ?? "")
        const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { answer?: unknown; text?: unknown }
        const r =
          op === "answer" ? yield* inbox.answer(topic, { ...(typeof body.answer === "string" ? { answer: body.answer } : {}), ...(typeof body.text === "string" ? { text: body.text } : {}) })
          : op === "snooze" ? yield* inbox.snooze(topic)
          : op === "read" ? yield* inbox.read(topic)
          : { ok: false, notice: `unknown inbox action ${op}` }
        return HttpServerResponse.jsonUnsafe({ notice: r.notice }, { status: r.ok ? 200 : 409 })
      })),
```
(Match the file's `jsonUnsafe` status option. If it takes no status, use the file's `error(status, message)` helper for the 409 branch.) Add the routes to the API doc comment.

In `live.ts`, after `const prompts = makePrompts(log)`:
```ts
    const inbox = yield* makeInbox({ log, dir: join(root, ".zarg", "inbox"), answered: (t, r) => (t.from.plugin === "zarg" ? Effect.void : Effect.ignore(host.invoke(t.from.plugin, "answered", { id: t.id, ...r }))) })
```
(`host` must exist by then: place the line where `host` is in scope, before anything that uses `inbox`.) Add `inbox` to the returned object. In `main.ts`, add `Layer.succeed(InboxControl, core.inbox)` to the provided layers.

- [ ] **Step 4: Run.** `cd packages/core && mise x -- bun test test/inbox-routes.test.ts && mise x -- bunx tsc`. Expected: PASS.

- [ ] **Step 5: Commit.** `mise run build:plugins && mise run verify`, then commit `feat(core): inbox routes (answer, batch, snooze, read), wired into the core`.

### Task 3: The plugin power `Inbox`

**Files:**
- Modify: `packages/plugin-sdk/src/services.ts` (the `Inbox` service, and `inbox` in `servicesFrom`), `packages/plugin-sdk/src/define.ts` (the `inbox?: boolean` scope; `Layer.succeed(Inbox, s.inbox)`), `packages/plugin-sdk/src/index.ts` (export), `packages/plugin/src/runtime/grants.ts` (`inbox?: boolean` in `ManifestScopes`), `packages/plugin/src/runtime/powers.ts` (`"inbox.call"`), `packages/plugin/src/server/host.ts` (the `inbox?` host option, passed to powers), `packages/core/src/plugins.ts` (pass it through), `packages/core/src/live.ts` (serve it from `inbox`)
- Test: `packages/plugin/test/inbox-power.test.ts` (with a fixture plugin, following how `packages/plugin/test/*.test.ts` build and host fixture plugins)

**Interfaces:**
- Consumes: `InboxService` (Task 1)
- Produces:
  - Plugin side:
    ```ts
    class Inbox { ask(t: TopicInput): Effect<Reply, PluginFailure>; post(t): Effect<string, PluginFailure>; settle(id, why): Effect<void, PluginFailure>; update(id, patch): Effect<void, PluginFailure> }
    ```
  - Host option: `inbox?: (plugin: string, op: "ask" | "post" | "settle" | "update", args: unknown) => Effect<unknown, unknown>`.

- [ ] **Step 1: Write the failing test.** A fixture plugin declaring `scopes: { inbox: true }` with methods `ask` (calls `Inbox.ask({ kind: "question", title: "Q?", why: "test", answers: [{ id: "a", label: "A" }] })` and returns its reply), `post` (returns the id), `settle` and `answered` (records its params). A second fixture declares no `inbox` scope. Host them with an `inbox` option backed by a real `makeInbox` over temp dirs, with `answered` calling `host.invoke(plugin, "answered", …)`. Assert:
  - `invoke("asker", "ask", {})` resolves `{ answer: "a" }` after `inbox.answer(id, { answer: "a" })`. The call's deadline doesn't fire meanwhile: run it past the plugin's deadline with a short `deadlineMs`.
  - `post`, then `inbox.answer`, reaches the plugin's `answered` with `{ id, answer }`.
  - The plugin without the scope fails `ask` with "has no inbox scope".
  - `settle` on another plugin's topic id leaves it open (notice "not asker's topic").

- [ ] **Step 2: Run.** Expected: FAIL (no `Inbox` export / no `inbox.call` power).

- [ ] **Step 3: Implement.**

`services.ts`:
```ts
/** The operator's inbox (scope `inbox: true`): ask (waits for the answer), post (the answer comes to your `answered` method), settle, update. */
export class Inbox extends Context.Service<Inbox, {
  readonly ask: (t: TopicInput) => Effect.Effect<{ readonly answer?: string; readonly text?: string }, PluginFailure>
  readonly post: (t: TopicInput) => Effect.Effect<string, PluginFailure>
  readonly settle: (id: string, why: string) => Effect.Effect<void, PluginFailure>
  readonly update: (id: string, patch: Partial<TopicInput> & { readonly message?: string }) => Effect.Effect<void, PluginFailure>
}>()("@zarg/plugin-sdk/Inbox") {}
```
Define `TopicInput` there with the same fields as Task 1's. Keep it a plain type, so the sandbox needs no core import. In `servicesFrom`:
```ts
  inbox: Inbox.of({
    ask: (t) => Effect.acquireUseRelease(power(raw, "conversation.asking", { open: true }), () => power(raw, "inbox.call", { op: "ask", topic: t }), () => Effect.ignore(power(raw, "conversation.asking", { open: false }))),
    post: (t) => power(raw, "inbox.call", { op: "post", topic: t }),
    settle: (id, why) => Effect.asVoid(power(raw, "inbox.call", { op: "settle", id, why })),
    update: (id, patch) => Effect.asVoid(power(raw, "inbox.call", { op: "update", id, patch })),
  }),
```
(`conversation.asking` needs the `agents` scope today. Relax its check to `agents === true || inbox === true`, so a waiting ask pauses the deadline.)

`powers.ts`:
```ts
    "inbox.call": async (a) => {
      if (opts.manifest.scopes.inbox !== true) throw notGranted(`${opts.plugin}: it has no inbox scope`)
      if (opts.inbox === undefined) throw pluginError(`${opts.plugin}: this host has no inbox`)
      const x = a as { op?: unknown }
      if (!["ask", "post", "settle", "update"].includes(String(x.op))) throw pluginError(`${opts.plugin}: unknown inbox op ${printable(String(x.op))}`)
      return await opts.inbox(String(x.op) as "ask" | "post" | "settle" | "update", a)
    },
```
with `readonly inbox?: (op: "ask" | "post" | "settle" | "update", args: unknown) => Promise<unknown>` in the powers options.

In `host.ts`:
- The option: `readonly inbox?: (plugin: string, op: "ask" | "post" | "settle" | "update", args: unknown) => Effect.Effect<unknown, unknown>`.
- Pass it to powers next to `decide`: `...(opts.inbox !== undefined ? { inbox: (op, args) => Effect.runPromise(opts.inbox!(m.name, op, args)) } : {})`.
- Add `inbox` to `graphOnly`'s reasoning only if it reads scopes by name. It doesn't: `inbox` doesn't block auto-approval.

`core/src/plugins.ts`: pass `inbox` through, as `decide` is. `live.ts`:
```ts
      inbox: (plugin, op, args) => {
        const a = args as { topic?: TopicInput; id?: string; why?: string; patch?: Partial<TopicInput> & { message?: string } }
        return op === "ask" ? inbox.ask({ plugin }, a.topic!) : op === "post" ? inbox.post({ plugin }, a.topic!) : op === "settle" ? inbox.settle(plugin, a.id!, a.why ?? "") : inbox.update(plugin, a.id!, a.patch ?? {})
      },
```
(`inbox` is created in Task 2 before the host starts. If the host is created first, route through a `let inboxRef` set once the inbox exists, as `plugins.ts` does for `agents`.)

- [ ] **Step 4: Run.** `cd packages/plugin && mise x -- bun test test/inbox-power.test.ts`, then `mise x -- bunx tsc` in plugin, plugin-sdk and core. Expected: PASS.

- [ ] **Step 5: Commit.** Run `mise run build:plugins && mise run verify` (the first-party hashes change), then commit `feat(plugin): the Inbox power (ask, post, settle, update; scope inbox)`.

### Task 4: First source: disabled, failed and missing plugins

**Files:**
- Modify: `packages/plugin/src/server/host.ts:267,294,378,427` (call `opts.agendaChanged?.("host")` after each `hostItems.push`), `packages/core/src/live.ts` (sync plugin topics)
- Create: `packages/core/src/plugin-topics.ts`
- Test: `packages/core/test/plugin-topics.test.ts`

**Interfaces:**
- Consumes: `InboxService` (Task 1), the host's `agenda()` items with ids `plugin-disabled:<name>`, `plugin-failed:<name>`, `plugin-needs:<name>:<dep>`.
- Produces: `syncPluginTopics(inbox, items): Effect<void>`. It posts one `plugin` topic per such item, from `{ plugin: "zarg" }`, with `key` = the item id, the title, why = "plugin", evidence = the item's detail, and no answers (the host has no restart; the detail says to restart zarg). It settles "zarg" topics whose key is no longer among the items, with "the plugin loaded".

- [ ] **Step 1: Write the failing test** (`plugin-topics.test.ts`, using Task 1's temp setup):
```ts
test("a disabled plugin becomes a plugin topic; syncing again with it gone settles it", async () => {
  const { inbox } = await setup()
  const item = { id: "plugin-disabled:x", title: "Plugin x was disabled after 3 restarts", detail: "Restart zarg to try it again.", about: [], priority: 1 }
  await Effect.runPromise(syncPluginTopics(inbox, [item, { id: "backlog:needs:B-1", title: "t", detail: "", about: [], priority: 1 }]))
  await Effect.runPromise(syncPluginTopics(inbox, [item]))
  expect(inbox.list().map((t) => [t.kind, t.key, t.state, t.evidence])).toEqual([["plugin", "plugin-disabled:x", "open", "Restart zarg to try it again."]])
  await Effect.runPromise(syncPluginTopics(inbox, []))
  expect(inbox.list()[0]).toMatchObject({ state: "moot", moot: "the plugin loaded" })
})
```
(Export `setup` from a shared `packages/core/test/inbox-helper.ts`, and have Task 1's test import it too, rather than copying it.)

- [ ] **Step 2: Run.** Expected: FAIL (no module).

- [ ] **Step 3: Implement** `plugin-topics.ts`:
```ts
import { Effect } from "effect"
import type { InboxService } from "./inbox"

const PLUGIN_ITEM = /^plugin-(disabled|failed|needs):/
/** The host's plugin problems as inbox topics: one per problem, settled once it is gone. */
export const syncPluginTopics = (inbox: InboxService, items: ReadonlyArray<{ readonly id: string; readonly title: string; readonly detail: string }>) =>
  Effect.gen(function* () {
    const now = items.filter((i) => PLUGIN_ITEM.test(i.id))
    for (const i of now) yield* inbox.post({ plugin: "zarg" }, { kind: "plugin", key: i.id, title: i.title, why: "plugin", evidence: i.detail, severity: "high" })
    const keys = new Set(now.map((i) => i.id))
    for (const t of inbox.list()) if (t.from.plugin === "zarg" && t.kind === "plugin" && t.state === "open" && t.key !== undefined && !keys.has(t.key)) yield* inbox.settle("zarg", t.id, "the plugin loaded")
  })
```
In `live.ts`: after plugins load, and wherever the host's `agendaChanged` is handled (live.ts:245), run `Effect.runFork(Effect.ignore(Effect.flatMap(host.agenda(), (items) => syncPluginTopics(inbox, items))))`. In `host.ts`, after each of the four `hostItems.push(...)`, call `opts.agendaChanged?.("host")`.

- [ ] **Step 4: Run.** `cd packages/core && mise x -- bun test test/plugin-topics.test.ts test/inbox.test.ts`, then `cd ../plugin && mise x -- bun test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(core): a disabled, failed or missing plugin is an inbox topic, settled once it loads`.

### Task 5: Client: topics in the state, `priorityOf`, the session's answers

**Files:**
- Create: `packages/client/src/inbox.ts`
- Modify: `packages/client/src/state.ts` (`ThreadState.inbox`, `reduce`), `packages/client/src/client.ts` (4 requests), `packages/client/src/session.ts` (4 methods), `packages/client/src/index.ts` (exports)
- Test: `packages/client/test/inbox.test.ts`, `packages/client/test/state.test.ts`

**Interfaces:**
- Consumes: the `zarg.inbox` event `{ topic }` (Task 1). The `Topic` shape is redeclared in `@zarg/client/src/inbox.ts`, since the client never imports core.
- Produces:
  - `type Topic`
  - `priorityOf(t: Topic, now: number): number` (lower is sooner)
  - `sortTopics(ts: Iterable<Topic>, now: number): Array<Topic>`
  - `openTopics(s: ThreadState): Array<Topic>` (open ones, sorted)
  - `ThreadState.inbox?: Readonly<Record<string, Topic>>`
  - Session: `answerTopic(id, answer?, text?)`, `answerTopics(ids, answer, text?)`, `snoozeTopic(id)`, `readTopic(id)`, each setting `notice` as `answerPrompt` does.

- [ ] **Step 1: Write the failing tests**

`packages/client/test/inbox.test.ts`:
```ts
import { expect, test } from "bun:test"
import { priorityOf, sortTopics, type Topic } from "../src/inbox"

const t = (id: string, over: Partial<Topic> = {}): Topic => ({ id, kind: "question", from: { plugin: "p" }, title: id, why: "", about: [], blocking: false, messages: [], state: "open", created: 0, updated: 0, ...over })
test("priority: blocking, then answers, then by severity, then reports; older first within a tier; snoozed last", () => {
  const list = [
    t("report", { kind: "report", created: 1 }),
    t("finding-low", { severity: "low", created: 1 }),
    t("finding-high", { severity: "high", created: 5 }),
    t("choice-new", { answers: [{ id: "a", label: "A" }], created: 9 }),
    t("choice-old", { answers: [{ id: "a", label: "A" }], created: 2 }),
    t("grant", { blocking: true, answers: [{ id: "a", label: "A" }], created: 50 }),
    t("snoozed", { answers: [{ id: "a", label: "A" }], snoozed: { until: "change" }, created: 0 }),
  ]
  expect(sortTopics(list, 100).map((x) => x.id)).toEqual(["grant", "choice-old", "choice-new", "finding-high", "finding-low", "report", "snoozed"])
  expect(priorityOf(list[5]!, 100)).toBeLessThan(priorityOf(list[4]!, 100))
})
```
A report is a topic with no answers, no severity and `kind: "report"`. The tiers are:
- 0: blocking;
- 1: has answers;
- 2: severity high;
- 3: medium;
- 4: low;
- 5: report or anything else;
- 9: snoozed.

`priorityOf` = `tier * 1e13 + created`.

Add to `packages/client/test/state.test.ts`:
```ts
test("zarg.inbox events fold into inbox by id, whatever thread the session follows", () => {
  const topic = { id: "T-1", kind: "grant", from: { plugin: "p" }, title: "t", why: "", about: [], blocking: true, messages: [], state: "open", created: 1, updated: 1 }
  let s = initial("other")
  s = reduce(s, { type: "CUSTOM", name: "zarg.inbox", value: { topic }, threadId: "main", seq: 1 } as never)
  s = reduce(s, { type: "CUSTOM", name: "zarg.inbox", value: { topic: { ...topic, state: "answered" } }, threadId: "main", seq: 2 } as never)
  expect(s.inbox).toEqual({ "T-1": { ...topic, state: "answered" } })
})
```
(Use the file's own `initial` and wire-event helpers.)

- [ ] **Step 2: Run.** `cd packages/client && mise x -- bun test test/inbox.test.ts test/state.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/client/src/inbox.ts`:
```ts
/** An inbox topic, as the core sends it (`zarg.inbox`). */
export interface Topic {
  readonly id: string; readonly kind: string; readonly from: { readonly plugin: string; readonly agent?: string }
  readonly title: string; readonly why: string; readonly about: ReadonlyArray<string>; readonly blocking: boolean
  readonly severity?: "high" | "medium" | "low"
  readonly answers?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly recommended?: boolean; readonly why?: string; readonly reason?: "optional" | "required" }>
  readonly text?: { readonly placeholder: string }; readonly evidence?: string; readonly origin?: { readonly view: string; readonly row?: string }
  readonly key?: string; readonly messages: ReadonlyArray<{ readonly by: string; readonly at: number; readonly text: string }>
  readonly state: "open" | "answered" | "moot" | "read"
  readonly answer?: { readonly id?: string; readonly text?: string; readonly by: string; readonly at: number }
  readonly moot?: string; readonly snoozed?: { readonly until: "change" }; readonly created: number; readonly updated: number
}
const tier = (t: Topic) =>
  t.snoozed !== undefined ? 9 : t.blocking ? 0 : (t.answers ?? []).length > 0 ? 1 : t.severity === "high" ? 2 : t.severity === "medium" ? 3 : t.severity === "low" ? 4 : 5
/** The one priority: lower is sooner. Blocking, then answers, then severity, then reports; older first; snoozed last. */
export const priorityOf = (t: Topic, _now: number) => tier(t) * 1e13 + t.created
export const sortTopics = (ts: Iterable<Topic>, now: number) => [...ts].sort((a, b) => priorityOf(a, now) - priorityOf(b, now))
```
`state.ts`:
- Add `readonly inbox?: Readonly<Record<string, Topic>>` to `ThreadState`.
- At the top of `reduce`, next to the prompts branch:
```ts
  // Inbox topics are the core's too: every client keeps them, whatever thread it follows.
  if (e.type === "CUSTOM" && e.name === "zarg.inbox" && e.seq > s.seq) {
    const topic = (e.value as { topic?: Topic } | undefined)?.topic
    return topic === undefined ? { ...s, seq: e.seq } : { ...s, seq: e.seq, inbox: { ...(s.inbox ?? {}), [topic.id]: topic } }
  }
```
- Add `export const openTopics = (s: ThreadState, now = Date.now()) => sortTopics(Object.values(s.inbox ?? {}).filter((t) => t.state === "open"), now)`.

`client.ts`, next to `answerPrompt`:
```ts
    answerTopic: (id: string, body: { readonly answer?: string; readonly text?: string }) => json(`/inbox/${encodeURIComponent(id)}/answer`, body),
    answerTopics: (body: { readonly ids: ReadonlyArray<string>; readonly answer: string; readonly text?: string }) => json(`/inbox/answer`, body),
    snoozeTopic: (id: string) => json(`/inbox/${encodeURIComponent(id)}/snooze`, {}),
    readTopic: (id: string) => json(`/inbox/${encodeURIComponent(id)}/read`, {}),
```
Here `json` is a local helper: `request(path, { method: "POST", body: JSON.stringify(body) })`, then read `{ notice }` whatever the status (a 409 carries its notice). Write the helper if the file has none.

`session.ts`: four methods shaped like `answerPrompt`, each setting `notice`. Export `Topic`, `priorityOf`, `sortTopics` and `openTopics` from `index.ts`.

- [ ] **Step 4: Run.** `cd packages/client && mise x -- bun test && mise x -- bunx tsc`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(client): inbox topics in the state, priorityOf, and the session's answers`.

### Task 6: TUI: the inbox is home; the topic view

**Files:**
- Create: `packages/view-tui/src/inbox.tsx` (the list and the topic view, drawn), `packages/view-tui/src/inbox-keys.ts` (pure: rows, cursor, marks, the key handler)
- Modify:
  - `packages/view-tui/src/view.ts`: `Main` gains `"inbox"`; `Ui` gains `inbox: { cursor: number; open?: string; marked: ReadonlyArray<string>; all: boolean }`; `goHome` goes to `"inbox"`; `statusLine` counts.
  - `packages/view-tui/src/layers.ts`: an `inbox` layer before `grid`; `g` prefers blocking topics.
  - `packages/view-tui/src/app.tsx`: render `main === "inbox"`; the Inbox row in the rail's VIEWS band; the action handling for `answer-topic`, `answer-topics`, `snooze-topic`, `read-topic`.
  - `packages/view-tui/src/palette.ts`: an `agents` entry to the grid.
- Test: `packages/view-tui/test/inbox.test.ts` (pure keys), `packages/view-tui/test/app.test.tsx` (rendering)

**Interfaces:**
- Consumes: `openTopics`, `sortTopics`, `Topic` (Task 5); the session's `answerTopic`, `answerTopics`, `snoozeTopic`, `readTopic`.
- Produces:
  - The actions `{ type: "answer-topic", id, answer?, text? }`, `{ type: "answer-topics", ids, answer }`, `{ type: "snooze-topic", id }` and `{ type: "read-topic", id }`, which app.tsx sends to the session.
  - `inboxRows(ui, s)`.

- [ ] **Step 1: Write the failing tests**

`packages/view-tui/test/inbox.test.ts` (pure):
```ts
import { expect, test } from "bun:test"
import { initial } from "@zarg/client"
import { inboxKey, inboxRows } from "../src/inbox-keys"
import { initialUi } from "../src/view"

const topic = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "grant", from: { plugin: "backlog" }, title: `t ${id}`, why: "fs write", about: [], blocking: false, messages: [], state: "open", created: Number(id.slice(2)), updated: 0, answers: [{ id: "once", label: "Allow once" }, { id: "deny", label: "Deny" }], ...over })
const s = (...ts: Array<ReturnType<typeof topic>>) => ({ ...({} as never), thread: { ...initial("main"), inbox: Object.fromEntries(ts.map((t) => [t.id, t])) } }) as never
const key = (name: string, extra: Record<string, unknown> = {}) => ({ name, ctrl: false, meta: false, shift: false, sequence: name, ...extra }) as never
const home = { ...initialUi, main: "inbox" as const, focus: "tile" as const, inbox: { cursor: 0, marked: [], all: false } }

test("rows: open topics, sorted; Enter opens one; a number answers it; t asks for text; z on a blocking topic is refused", () => {
  const st = s(topic("T-2"), topic("T-1", { blocking: true }))
  expect(inboxRows(home, st).map((t) => t.id)).toEqual(["T-1", "T-2"])
  const opened = inboxKey(home, st, key("return")).ui
  expect(opened.inbox.open).toBe("T-1")
  expect(inboxKey(opened, st, key("2")).action).toEqual({ type: "answer-topic", id: "T-1", answer: "deny" })
  expect(inboxKey(opened, st, key("z")).notice).toBe("something waits on it: it cannot be snoozed")
  expect(inboxKey(opened, st, key("t")).ui.inbox.typing).toEqual({ id: "T-1" })
})
test("batch: space marks topics of one kind; a number answers them all", () => {
  const st = s(topic("T-1"), topic("T-2"), topic("T-3", { kind: "drift", answers: [{ id: "card", label: "Reword" }] }))
  let ui = inboxKey(home, st, key("space")).ui
  ui = inboxKey({ ...ui, inbox: { ...ui.inbox, cursor: 1 } }, st, key("space")).ui
  expect(ui.inbox.marked).toEqual(["T-1", "T-2"])
  expect(inboxKey({ ...ui, inbox: { ...ui.inbox, cursor: 2 } }, st, key("space")).notice).toBe("a batch is one kind of topic")
  expect(inboxKey(ui, st, key("1")).action).toEqual({ type: "answer-topics", ids: ["T-1", "T-2"], answer: "once" })
})
```
In `app.test.tsx`, following the file's `render` helper:
```tsx
test("home is the inbox: blocking first with ◆, an empty inbox says so, the status line counts", async () => {
  const empty = await render(idleState, { width: 120, height: 24 })
  expect(empty.captureCharFrame()).toContain("Nothing needs you")
  const t = await render({ ...idleState, thread: { ...idleState.thread, inbox: { "T-1": grantTopic, "T-2": reportTopic } } }, { width: 120, height: 24 })
  const f = t.captureCharFrame()
  expect(f.indexOf("◆ backlog")).toBeLessThan(f.indexOf("· rehearse"))
  expect(f).toContain("◆ 1 blocking · 2 open")
})
```
(`idleState` stands for the file's existing idle fixture; `grantTopic` is blocking, `reportTopic` has `kind: "report"` and `from.plugin: "rehearse"`.) If zarg's sheet opens over home on arrival when idle, close it in the test with Alt+V, as other tests do: the arrival rule is unchanged in this spec.

- [ ] **Step 2: Run.** `cd packages/view-tui && mise x -- bun test test/inbox.test.ts`. Expected: FAIL (no module).

- [ ] **Step 3: Implement**

`inbox-keys.ts`:
- `inboxRows(ui, s)` returns `ui.inbox.all ? sortTopics(Object.values(s.thread.inbox ?? {}), Date.now()) : openTopics(s.thread)`.
- `inboxKey(ui, s, k)` returns `{ ui, action?, notice? }`:
  - **List** (no `open`):
    - ↑↓ move the cursor; Enter opens the topic;
    - space marks it, refused with "a batch is one kind of topic" when its kind differs from the marked ones;
    - with marks, `1-9` answers the batch with the n-th answer of the first marked topic;
    - `a` toggles `all`;
    - `/` searches: a query ranks rows with `@zarg/bm25` over title, why and evidence (as tables with `search: true` do), and Esc clears it;
    - `z` snoozes (refused locally with the same notice as the core on blocking topics); Esc clears marks.
  - **Topic** (`open`):
    - `1-9` answers the n-th answer;
    - `t` sets `ui.inbox.typing = { id }`. The bar takes a line; its Enter sends `{ type: "answer-topic", id, text }`, plus `answer` when an answer is highlighted.
    - `o` goes to `origin.view` with `goTo(ui, "agent", origin.view)`; `z` as in the list.
    - Opening a report sends `read-topic`.
    - Esc goes back to the list.

`inbox.tsx`: a React component in the style of the review queue (`app.tsx` near line 730, `review.ts`):
- **List:** one row per topic: glyph (`◆` blocking, `◇` has answers, `·` otherwise), who asks (`from.agent ?? from.plugin`), title, the kind with a hint (`grant · waiting`, `3 options`, `2 replies` from `messages.length`), and the age (`2m`, `1h`). The cursor row is highlighted and marked rows show `●`. With no topics: "Nothing needs you."
- **Topic view:** title line, `from · kind · why`, the evidence through the existing Markdown renderer, the messages (`by`, then text), then the answers as `1 Label (recommended)` buttons. Draw them with the same button styling as view actions; a click answers.

`view.ts`:
- `Main = "grid" | "agent" | "zarg" | "review" | "inbox"`.
- `initialUi.main = "inbox"`, `initialUi.inbox = { cursor: 0, marked: [], all: false }`.
- `goHome` sets `main: "inbox"`.
- `statusLine` prepends `◆ ${b} blocking · ${n} open` (or `${n} open`) when there are open topics.

`layers.ts`: an `inbox` layer (`when: ui.focus === "tile" && ui.main === "inbox" && !ui.sheet`) that calls `common(ui, w, k)` first, then `inboxKey`. In `nextAttention`, go first to the first open blocking topic, opening it in the inbox, before agents.

`app.tsx`:
- Render `main === "inbox"`.
- Add the rail row `Inbox <n>` at the top of the VIEWS band, with ◆ blinking while a blocking topic is unseen (keep seen ids in `ui.seen` keyed `inbox:<id>`); a click goes home.
- Handle the four actions by calling the session.

`palette.ts`: an entry `agents` that does `goTo(ui, "grid")`.

- [ ] **Step 4: Run.** `cd packages/view-tui && mise x -- bun test && mise x -- bunx tsc`. Expected: PASS.
  - Tests that asserted `main === "grid"` as home now expect `"inbox"`. Update those expectations, and only those.
  - Snapshot tests of the home screen: update the snapshots after reading the new frame.

- [ ] **Step 5: Commit** `feat(tui): the inbox is home: sorted topics, the topic view, numbers answer, t with text, space batches, g to blocking`.

### Task 7: Docs

**Files:**
- Modify: `AGENTS.md` (the core, client, view-tui and plugin-sdk lines)

- [ ] **Step 1: Update AGENTS.md**
  - core: "the operator's inbox (`.zarg/inbox/`, gitignored): topics raised by plugins (`Inbox` power) and the core (disabled plugins), `zarg.inbox` events on main, `POST /inbox/:id/answer|snooze|read`, `POST /inbox/answer` for a batch".
  - plugin-sdk: add `Inbox` to the list of powers, with the `inbox: true` scope.
  - client: "`ThreadState.inbox`, `priorityOf`/`openTopics`".
  - view-tui: "home is the inbox (the grid is `^k agents`): topics sorted by priority, Enter opens one, numbers answer, `t` answers with text, space marks a batch, `z` snoozes (not blocking ones), `g` goes to the next blocking topic first; the status line counts blocking and open topics".
- [ ] **Step 2: Verify and commit.** `mise run build:plugins && mise run verify`, then commit `docs: the inbox in AGENTS.md`.
