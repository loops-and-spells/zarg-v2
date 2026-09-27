import type { Layout } from "./schema"

/** The AG-UI activity type views travel as. */
export const VIEW_ACTIVITY = "zarg.view"
/** A log keeps this many of its last lines; older ones stay in the transcript. */
export const LOG_KEEP = 2000
export const viewMessageId = (thread: string, agent: string) => `${thread}:view:${agent}`

export interface ViewState {
  readonly agent: string
  readonly layout: Layout
  /** Each leaf's data by path (`id` or `tabs.tab`). */
  readonly data: Readonly<Record<string, unknown>>
}
export type Views = Readonly<Record<string, ViewState>>
export interface ViewEvent {
  readonly type: string
  readonly activityType?: unknown
  readonly content?: unknown
  readonly patch?: unknown
}

export const isViewEvent = (e: ViewEvent) => (e.type === "ACTIVITY_SNAPSHOT" || e.type === "ACTIVITY_DELTA") && e.activityType === VIEW_ACTIVITY

type Op = { readonly op: string; readonly path: string; readonly value?: unknown }
const PATH = /^\/data\/([^/]+)(\/lines\/-)?$/

/** Fold one AG-UI event into the views; events that are not views leave them as they are. */
export const reduceView = (views: Views, e: ViewEvent): Views => {
  if (!isViewEvent(e)) return views
  const agent = String((e.content as { agent?: unknown } | undefined)?.agent ?? "")
  if (e.type === "ACTIVITY_SNAPSHOT") {
    const c = e.content as { layout: Layout; data?: Record<string, unknown> }
    return { ...views, [agent]: { agent, layout: c.layout, data: c.data ?? {} } }
  }
  const v = views[agent]
  if (v === undefined) return views
  const data: Record<string, unknown> = { ...v.data }
  // A log's appended lines are gathered per key and joined once (a delta can carry thousands).
  const added = new Map<string, Array<unknown>>()
  const join = (key: string) => {
    const more = added.get(key)
    if (more === undefined) return
    added.delete(key)
    const lines = [...((data[key] as { lines?: ReadonlyArray<unknown> } | undefined)?.lines ?? []), ...more]
    data[key] = { lines: lines.length > LOG_KEEP ? lines.slice(lines.length - LOG_KEEP) : lines }
  }
  for (const p of (e.patch as ReadonlyArray<Op>) ?? []) {
    const m = PATH.exec(p.path)
    if (m === null) continue
    const key = m[1]!.replace(/~1/g, "/").replace(/~0/g, "~")
    if (m[2] !== undefined && p.op === "add") {
      const more = added.get(key)
      if (more === undefined) added.set(key, [p.value])
      else more.push(p.value)
    } else if (m[2] === undefined && (p.op === "replace" || p.op === "add")) {
      added.delete(key)
      data[key] = p.value
    }
  }
  for (const key of [...added.keys()]) join(key)
  return { ...views, [agent]: { ...v, data } }
}
