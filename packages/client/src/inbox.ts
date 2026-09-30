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

/** A refused inbox request's notice: the core's `{ notice }`, or the body as it is. */
export const noticeOf = (body: string): string => {
  try {
    const n = (JSON.parse(body) as { notice?: unknown }).notice
    return typeof n === "string" ? n : body
  } catch {
    return body
  }
}
