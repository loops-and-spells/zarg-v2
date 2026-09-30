import { Deferred, Effect } from "effect"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as E from "./events"
import type { ThreadLog } from "./log"

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
