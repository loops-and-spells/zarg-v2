import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Effect, PubSub, Stream } from "effect"
import type { Draft, WireEvent } from "./events"

/** Per-thread RLM transcripts sit next to the event logs and are not events. */
const TRANSCRIPT = ".rlm.jsonl"

/** Redact every string value, never keys or the JSON around them (an escaped secret would slip past, a short one could hit a key). */
const redactValues = (value: unknown, redact: (text: string) => string): unknown =>
  typeof value === "string"
    ? redact(value)
    : Array.isArray(value)
      ? value.map((v) => redactValues(v, redact))
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValues(v, redact)]))
        : value

/**
 * Every event of every thread, in order: kept in memory for `/stream?since=`, appended to
 * `<dir>/<threadId>.jsonl`, and published to live subscribers. `redact` runs before anything is stored or sent.
 */
export const makeLog = (dir: string, redact: (text: string) => string) =>
  Effect.gen(function* () {
    mkdirSync(dir, { recursive: true })
    const events: Array<WireEvent> = []
    // Earlier sessions' events come first so sequence numbers keep increasing across restarts.
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(TRANSCRIPT)).sort()) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (line.trim().length === 0) continue
        // A line cut short by a crash is skipped; the rest of the log stays usable.
        try {
          events.push(JSON.parse(line) as WireEvent)
        } catch {}
      }
    }
    events.sort((a, b) => a.seq - b.seq)
    let seq = events.at(-1)?.seq ?? 0
    const hub = yield* PubSub.unbounded<WireEvent>()

    const append = (threadId: string, draft: Draft): Effect.Effect<WireEvent> =>
      Effect.gen(function* () {
        const event = { ...(redactValues(draft, redact) as Draft), threadId, seq: ++seq } as WireEvent
        events.push(event)
        appendFileSync(join(dir, `${threadId}.jsonl`), `${JSON.stringify(event)}\n`)
        yield* PubSub.publish(hub, event)
        return event
      })

    /** Events after `since`, then live events, optionally for one thread. */
    const stream = (since: number, threadId?: string): Stream.Stream<WireEvent> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const sub = yield* PubSub.subscribe(hub)
          const past = events.filter((e) => e.seq > since && (threadId === undefined || e.threadId === threadId))
          const last = past.at(-1)?.seq ?? since
          const live = Stream.fromSubscription(sub).pipe(Stream.filter((e: WireEvent) => e.seq > last && (threadId === undefined || e.threadId === threadId)))
          return Stream.concat(Stream.fromIterable(past), live)
        }),
      )

    /** Append a record to the thread's RLM transcript (`<thread>.rlm.jsonl`): redacted, stored only, never sent. */
    const transcript = (threadId: string, record: Record<string, unknown>) =>
      Effect.sync(() => appendFileSync(join(dir, `${threadId}${TRANSCRIPT}`), `${JSON.stringify({ ...(redactValues(record, redact) as object), at: new Date().toISOString() })}\n`))

    /**
     * One agent's transcript lines since it last started: RLM ids start over with each driver item, so the
     * latest start is the agent the tree shows now.
     */
    const history = (threadId: string, rlm: string): ReadonlyArray<Record<string, any>> => {
      const file = join(dir, `${threadId}${TRANSCRIPT}`)
      if (!existsSync(file)) return []
      const needle = `"rlm":${JSON.stringify(rlm)}`
      const mine: Array<Record<string, any>> = []
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes(needle)) continue
        try {
          const l = JSON.parse(line) as Record<string, any>
          if (l.rlm !== rlm) continue
          if (l.type === "start") mine.length = 0
          mine.push(l)
        } catch {}
      }
      return mine
    }

    /** End every live stream (shutdown): open SSE responses finish instead of holding the server open. */
    const close = PubSub.shutdown(hub)

    return { append, stream, close, transcript, history, redact, all: () => events as ReadonlyArray<WireEvent>, exists: (threadId: string) => existsSync(join(dir, `${threadId}.jsonl`)) }
  })

export type ThreadLog = Effect.Success<ReturnType<typeof makeLog>>
