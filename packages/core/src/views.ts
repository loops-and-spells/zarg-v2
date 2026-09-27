import { Effect } from "effect"
import { checkAppend, checkSet, type Layout, LOG_KEEP, reduceView, VIEW_ACTIVITY, viewMessageId, type Views } from "@zarg/view"
import * as E from "./events"
import type { ThreadLog } from "./log"

/** An agent that declared no view: its step lines in one log. */
export const DEFAULT_LAYOUT: Layout = { name: "default", sections: [{ id: "history", kind: "log", role: "log" }] }

const DELAY_MS = 100
const redactDeep = (v: unknown, redact: (t: string) => string): unknown =>
  typeof v === "string" ? redact(v) : Array.isArray(v) ? v.map((x) => redactDeep(x, redact)) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, redact)])) : v
const seg = (path: string) => path.replaceAll("~", "~0").replaceAll("/", "~1")

/**
 * Every agent view in one thread: checked pushes, kept state, and AG-UI events (a snapshot at start, then deltas
 * coalesced per agent within `delayMs`). Views live here, so they outlive the process that drew them.
 */
export const makeViews = (log: ThreadLog, threadId: string, opts: { readonly delayMs?: number } = {}) => {
  // A restarted core starts from what its clients replay: the thread log's view events, folded.
  const replayed = log.all().filter((e) => e.threadId === threadId).reduce((v: Views, e) => reduceView(v, e as never), {})
  const states = new Map<string, { layout: Layout; data: Record<string, unknown> }>(Object.values(replayed).map((v) => [v.agent, { layout: v.layout, data: { ...v.data } }]))
  const pending = new Map<string, Array<Record<string, unknown>>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const send = (agent: string) => {
    const patch = pending.get(agent)
    pending.delete(agent)
    if (patch === undefined || patch.length === 0) return
    // Newest first: a section's last replace wins (earlier ones and the adds it overwrites are dead weight),
    // and a log's lines beyond what the view keeps would be dropped by every client anyway.
    const replaced = new Set<string>()
    const kept = new Map<string, number>()
    const trimmed = [...patch].reverse().filter((p) => {
      const path = String(p.path)
      if (!path.endsWith("/lines/-")) {
        if (replaced.has(path)) return false
        replaced.add(path)
        return true
      }
      if (replaced.has(path.slice(0, -"/lines/-".length))) return false
      const n = (kept.get(path) ?? 0) + 1
      kept.set(path, n)
      return n <= LOG_KEEP
    }).reverse()
    // Sent from a timer: a thread log already closed (the core shutting down) drops the delta instead of throwing.
    Effect.runSync(Effect.ignore(log.append(threadId, E.activityDelta(viewMessageId(threadId, agent), trimmed, VIEW_ACTIVITY, { agent })).pipe(Effect.catchDefect(() => Effect.void))))
  }
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    for (const agent of [...pending.keys()]) send(agent)
  }
  const queue = (agent: string, ops: ReadonlyArray<Record<string, unknown>>) => {
    const q = pending.get(agent)
    if (q === undefined) pending.set(agent, [...ops])
    else q.push(...ops)
    if (timer === undefined) {
      timer = setTimeout(flush, opts.delayMs ?? DELAY_MS)
      timer.unref?.()
    }
  }
  const state = (agent: string) => {
    const s = states.get(agent)
    if (s === undefined) throw new Error(`agent ${agent} has no view (start it first)`)
    return s
  }
  return {
    start: (agent: string, layout: Layout) => {
      // Anything still queued for an earlier run of this agent goes first.
      send(agent)
      states.set(agent, { layout, data: {} })
      Effect.runSync(log.append(threadId, E.activitySnapshot(viewMessageId(threadId, agent), { agent, layout, data: {} }, VIEW_ACTIVITY)))
    },
    set: (agent: string, path: string, data: unknown) => {
      const s = state(agent)
      const r = checkSet(s.layout, path, redactDeep(data, log.redact))
      if (!r.ok) throw new Error(r.error)
      s.data[path] = r.data
      queue(agent, [{ op: "replace", path: `/data/${seg(path)}`, value: r.data }])
    },
    append: (agent: string, path: string, lines: unknown) => {
      const s = state(agent)
      const r = checkAppend(s.layout, path, redactDeep(lines, log.redact))
      if (!r.ok) throw new Error(r.error)
      const all = [...((s.data[path] as { lines?: ReadonlyArray<unknown> } | undefined)?.lines ?? []), ...r.lines]
      s.data[path] = { lines: all.length > LOG_KEEP ? all.slice(all.length - LOG_KEEP) : all }
      queue(agent, r.lines.map((l) => ({ op: "add", path: `/data/${seg(path)}/lines/-`, value: l })))
    },
    has: (agent: string) => states.has(agent),
    layout: (agent: string) => states.get(agent)?.layout,
    flush,
  }
}
export type ViewStore = ReturnType<typeof makeViews>

const perLog = new WeakMap<ThreadLog, Map<string, ViewStore>>()
/** The one ViewStore of a thread (plugin agents and RLMs of that thread share it). */
export const threadViews = (log: ThreadLog, threadId: string): ViewStore => {
  let m = perLog.get(log)
  if (m === undefined) perLog.set(log, (m = new Map()))
  let v = m.get(threadId)
  if (v === undefined) m.set(threadId, (v = makeViews(log, threadId)))
  return v
}
