import { Deferred, Effect } from "effect"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
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
  /** A restart keeps it open: its owner hears the answer whenever it comes (zarg's questions). */
  readonly durable?: boolean
  readonly created: number; readonly updated: number
}
export type Reply = { readonly answer?: string; readonly text?: string }

const WEEK = 7 * 24 * 3600 * 1000
const ID = /^T-[0-9a-f]{8}$/
const str = (x: unknown) => (typeof x === "string" ? x : undefined)
/** What a plugin may say of a topic: its fields, checked; never its id, owner, state or whether it blocks. */
const fields = (x: Partial<TopicInput>): Partial<TopicInput> => {
  const out: Record<string, unknown> = {}
  for (const k of ["kind", "title", "why", "evidence", "key"] as const) if (str(x[k]) !== undefined) out[k] = x[k]
  if (Array.isArray(x.about)) out.about = x.about.filter((a) => typeof a === "string")
  if (x.severity === "high" || x.severity === "medium" || x.severity === "low") out.severity = x.severity
  if (Array.isArray(x.answers))
    out.answers = x.answers
      .filter((a) => str(a?.id) !== undefined && str(a?.label) !== undefined)
      .map((a) => ({ id: a.id, label: a.label, ...(a.recommended === true ? { recommended: true } : {}), ...(str(a.why) !== undefined ? { why: a.why } : {}), ...(a.reason === "optional" || a.reason === "required" ? { reason: a.reason } : {}) }))
  if (str(x.text?.placeholder) !== undefined) out.text = { placeholder: x.text!.placeholder }
  if (str(x.origin?.view) !== undefined) out.origin = { view: x.origin!.view, ...(str(x.origin!.row) !== undefined ? { row: x.origin!.row } : {}) }
  return out as Partial<TopicInput>
}
const newId = () => `T-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`

/** The operator's inbox: topics raised by plugins and the core, one file each, every change logged on main. */
export const makeInbox = (opts: {
  readonly log: ThreadLog
  readonly dir: string
  readonly now?: () => number
  readonly answered?: (t: Topic, r: Reply) => Effect.Effect<void>
  /** The operator replied in a topic (to talk it over): its owner hears it. */
  readonly replied?: (t: Topic, text: string) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const now = opts.now ?? Date.now
    mkdirSync(opts.dir, { recursive: true })
    // Operator state, never the project's: a * .gitignore inside keeps it out of the repository.
    if (!existsSync(join(opts.dir, ".gitignore"))) writeFileSync(join(opts.dir, ".gitignore"), "*\n")
    const topics = new Map<string, Topic>()
    const waiting = new Map<string, Deferred.Deferred<Reply>>()
    const save = (t: Topic) =>
      Effect.gen(function* () {
        // The id names the file: only the inbox's own ids (T-<8 hex>), never a path.
        if (!ID.test(t.id)) return yield* Effect.die(new Error(`not an inbox topic id: ${t.id}`))
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
      if (t.state === "open" && t.blocking && t.durable !== true) yield* save({ ...t, state: "moot", moot: "zarg restarted before it was answered", updated: now() })
      // Closed topics are in the log already; open ones are told again so clients that start fresh see them.
      else if (t.state === "open") yield* Effect.ignore(opts.log.append("main", E.custom(INBOX, { topic: t })))
    }
    // A corrupt file is reported once (a report keyed by its name), and skipped.
    for (const name of corrupt) {
      const key = `corrupt:${name}`
      if (![...topics.values()].some((x) => x.key === key)) {
        const at = now()
        yield* save({ id: newId(), kind: "report", key, from: { plugin: "zarg" }, title: `Inbox file ${name} is not a topic`, why: "inbox", evidence: `zarg skips .zarg/inbox/${name}. Fix or remove it.`, about: [], blocking: false, messages: [], state: "open", created: at, updated: at })
      }
    }
    const make = (from: Topic["from"], input: TopicInput, blocking: boolean): Topic => {
      const t = fields(input)
      return { ...t, kind: t.kind ?? "question", title: t.title ?? "", why: t.why ?? "", id: newId(), from, about: t.about ?? [], blocking, messages: [], state: "open", created: now(), updated: now() }
    }
    const check = (t: Topic | undefined, r: Reply): string | undefined => {
      if (t === undefined) return "no such topic"
      if (t.state !== "open") return `that topic is ${t.state}`
      if (r.answer === undefined) return t.text !== undefined && (r.text ?? "").trim() !== "" ? undefined : "an answer is needed"
      const a = (t.answers ?? []).find((x) => x.id === r.answer)
      if (a === undefined) return `${r.answer} is not one of its answers`
      if (a.reason === "required" && (r.text ?? "").trim() === "") return `${a.label} needs a reason`
      return undefined
    }
    const settleOne = (t0: Topic, r: Reply, by: string) =>
      Effect.gen(function* () {
        // Still open now (a batch runs one by one; another client may have answered meanwhile).
        const t = topics.get(t0.id)
        if (t === undefined || t.state !== "open") return
        const done: Topic = { ...t, state: "answered", answer: { ...(r.answer !== undefined ? { id: r.answer } : {}), ...(r.text !== undefined ? { text: r.text } : {}), by, at: now() }, updated: now() }
        yield* save(done)
        const d = waiting.get(t.id)
        if (d !== undefined) { waiting.delete(t.id); yield* Deferred.succeed(d, r) }
        // The plugin hears of it in the background: the operator's answer never waits on a plugin.
        else if (opts.answered !== undefined) yield* Effect.forkDetach(Effect.ignore(opts.answered(done, r)))
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
          if (same !== undefined) {
            // The same post again changes nothing; a new one wakes it (snoozed until it changes).
            const { snoozed: _, ...woken } = same
            const next: Topic = { ...woken, ...fields(input), updated: same.updated }
            if (JSON.stringify(next) === JSON.stringify(same)) return same.id
            yield* save({ ...next, updated: now() })
            return same.id
          }
          const t = make(from, input, false)
          yield* save(t)
          return t.id
        }),
      /** A topic of the core or a trusted agent: blocking or not, durable or not; its answer goes to `answered` (the owner waits in its own way). */
      raise: (from: Topic["from"], input: TopicInput, o: { readonly blocking: boolean; readonly durable: boolean }) =>
        Effect.gen(function* () {
          const t = make(from, input, o.blocking)
          yield* save(o.durable ? { ...t, durable: true } : t)
          return t.id
        }),
      /** The operator's reply in an open topic: kept as a message, and its owner hears it. */
      reply: (id: string, text: string) =>
        Effect.gen(function* () {
          const t = topics.get(id)
          if (t === undefined || t.state !== "open") return { ok: false, notice: t === undefined ? "no such topic" : `that topic is ${t.state}` }
          if (text.trim() === "") return { ok: false, notice: "an empty reply" }
          const next = { ...t, messages: [...t.messages, { by: "you", at: now(), text }], updated: now() }
          yield* save(next)
          if (opts.replied !== undefined) yield* Effect.forkDetach(Effect.ignore(opts.replied(next, text)))
          return { ok: true, notice: "sent" }
        }),
      /** A message from the topic's owner (zarg's note on it). */
      message: (id: string, by: string, text: string) =>
        Effect.gen(function* () {
          const t = topics.get(id)
          if (t === undefined) return
          yield* save({ ...t, messages: [...t.messages, { by, at: now(), text }], updated: now() })
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
          yield* save({ ...woken, ...fields(rest), messages: typeof message !== "string" ? t.messages : [...t.messages, { by: plugin, at: now(), text: message }], updated: now() })
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
          if (ids.length === 0) return { ok: false, notice: "nothing to answer" }
          const ts = [...new Set(ids)].map((id) => topics.get(id))
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
      /** A plugin stopped (it exited, crashed or restarted): the asks it was waiting on are moot, and their callers fail. */
      stopped: (plugin: string) =>
        Effect.gen(function* () {
          for (const t of [...topics.values()].filter((x) => x.from.plugin === plugin && x.state === "open" && x.blocking)) {
            yield* save({ ...t, state: "moot", moot: `${plugin} stopped`, updated: now() })
            const d = waiting.get(t.id)
            if (d !== undefined) {
              waiting.delete(t.id)
              yield* Deferred.interrupt(d)
            }
          }
        }),
      list: () => [...topics.values()],
    }
  })
export type InboxService = Effect.Success<ReturnType<typeof makeInbox>>
