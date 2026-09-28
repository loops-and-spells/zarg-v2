import { isViewEvent, reduceView, type Views } from "@zarg/view"
import type { Option, WireEvent } from "./events"

export interface Message {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly text: string
}

export interface Inquiry {
  readonly id: string
  readonly question: string
  readonly options: ReadonlyArray<Option>
  readonly allowOther: boolean
  /** The free-text row's label, when not "Something else". */
  readonly otherLabel?: string
  /** "grant": a permission question zarg asks; only its options are offered (no free text, no chat). */
  readonly kind?: "grant"
  readonly about: ReadonlyArray<string>
}

/** A popover in the core's queue, first in first out for every client: a grant it asks, or a plugin's view. */
export interface Prompt {
  readonly id: string
  /** A grant's question, or a plugin popover's header. */
  readonly question: string
  /** A grant's answers; a plugin's popover has none (it closes). */
  readonly options: ReadonlyArray<Option>
  readonly kind: "grant" | "surface"
  /** A plugin popover's view (a key of `views`) and the agent its actions go to. */
  readonly view?: string
  readonly agent?: string
}

/** A panel a plugin opened for one of its agents, at an edge of the tile area. */
/** A plugin's nav item: its label, and the view store key the plugin fills when it opens. */
export interface NavItem {
  readonly id: string
  readonly plugin: string
  readonly name: string
  readonly label: string
  readonly view: string
}
export interface Panel {
  readonly id: string
  readonly plugin: string
  readonly agent: string
  /** The view it shows: a key of `views`. */
  readonly view: string
  readonly name: string
  readonly scope: "agent" | "shell"
  readonly edge: "top" | "bottom" | "right"
  readonly size: number
  readonly input: "none" | "onFocus"
  /** When it was (re)opened. */
  readonly at?: number
}

export type Decision =
  | {
      readonly kind: "atomize"
      readonly atomic: boolean
      readonly criteria: ReadonlyArray<{ readonly name: string; readonly answer: boolean; readonly confidence: number }>
    }
  /** At its turn budget: extended to `turns`, or told to wrap up. */
  | { readonly kind: "extend"; readonly extended: boolean; readonly turns: number; readonly confidence: number; readonly reason: string }

export interface RlmNode {
  readonly id: string
  readonly parent: string | null
  readonly preset: string
  /** What the RLM was asked. */
  readonly task?: string
  readonly depth: number
  readonly turns: number
  readonly budget: number
  readonly tokens?: number
  readonly status: "running" | "done" | "failed" | "stopped"
  readonly decisions: ReadonlyArray<Decision>
  readonly error?: string
  /** A row the agent draws itself (agents that are not RLMs): progress fills the bar, text replaces the turns. */
  readonly row?: { readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }
  /** The agent asks for the operator: why, and since when (ms). */
  readonly attention?: { readonly reason: string; readonly since: number }
}

export interface ThreadState {
  readonly threadId: string
  readonly messages: ReadonlyArray<Message>
  readonly pendingInquiry?: Inquiry
  /** Every agent the thread shows: the driver's RLM tree and other activity streams (a rehearsal's testers). */
  readonly rlms: Readonly<Record<string, RlmNode>>
  /** The agents per activity stream (by message id), merged into `rlms`. */
  readonly streams?: Readonly<Record<string, Readonly<Record<string, RlmNode>>>>
  readonly status: "idle" | "running" | "waiting" | "error"
  readonly error?: { readonly code?: string; readonly message: string }
  /** The last event applied; events at or before it are ignored (replays after a reconnect). */
  readonly seq: number
  /** How many fresh (empty) RLM trees have started: a new driver item or pass. */
  readonly trees: number
  /** YOLO: plugins use every scope they declare without asking (`/yolo`, `zarg --yolo`). */
  readonly yolo?: boolean
  /** Each agent's view (zarg.view activities), by agent id. */
  readonly views?: Views
  /** The core's popovers (grants, plugins' popovers), in the order asked. */
  readonly prompts?: ReadonlyArray<Prompt>
  /** Agents out of the tree (restorable): why, and when (ms). */
  readonly archived?: Readonly<Record<string, { readonly reason: string; readonly at: number }>>
  /** Agents deleted for good: never shown again. */
  readonly deleted?: ReadonlyArray<string>
  /** The panels plugins have open. */
  readonly panels?: ReadonlyArray<Panel>
  /** The plugins' nav items, shown above the agents: each opens its plugin's view. */
  readonly nav?: ReadonlyArray<NavItem>
  /** The last tile or sheet a plugin opened for the operator, with the event's seq and time. */
  readonly navigate?: { readonly seq: number; readonly kind: "tile" | "sheet"; readonly view: string; readonly at: number }
}

export const initial = (threadId: string): ThreadState => ({ threadId, messages: [], rlms: {}, status: "idle", seq: 0, trees: 0 })

type Patch = { readonly op: string; readonly path: string; readonly value?: unknown }

const merged = (streams: NonNullable<ThreadState["streams"]>): ThreadState["rlms"] => Object.assign({}, ...Object.values(streams))

/** Apply the JSON Patch operations core sends for the RLM tree (add, replace, remove under /rlms). */
const patchRlms = (rlms: ThreadState["rlms"], patch: ReadonlyArray<Patch>) => {
  const next: Record<string, RlmNode> = { ...rlms }
  for (const p of patch) {
    const m = /^\/rlms\/([^/]+)$/.exec(p.path)
    if (m === null) continue
    const id = m[1]!.replace(/~1/g, "/").replace(/~0/g, "~")
    if (p.op === "remove") delete next[id]
    else if (p.op === "add" || p.op === "replace") next[id] = p.value as RlmNode
  }
  return next
}

/** Fold one core event into a thread's state. Events of other threads are ignored. */
export const reduce = (s: ThreadState, e: WireEvent): ThreadState => {
  // Prompts are the core's own questions: every client queues them, whatever thread it follows.
  if (e.type === "CUSTOM" && (e.name === "zarg.prompt" || e.name === "zarg.prompt.done") && e.seq > s.seq) {
    const v = e.value as { id?: unknown; question?: unknown; options?: ReadonlyArray<Option>; kind?: unknown; view?: unknown; agent?: unknown }
    const id = String(v.id)
    const rest = (s.prompts ?? []).filter((p) => p.id !== id)
    const prompt: Prompt =
      v.kind === "surface"
        ? { id, question: String(v.question ?? ""), options: [], kind: "surface", ...(typeof v.view === "string" ? { view: v.view } : {}), ...(typeof v.agent === "string" ? { agent: v.agent } : {}) }
        : { id, question: String(v.question ?? ""), options: v.options ?? [], kind: "grant" }
    return { ...s, seq: e.seq, prompts: e.name === "zarg.prompt" ? [...rest, prompt] : rest }
  }
  // Panels and navigation are the core's too.
  if (e.type === "ACTIVITY_SNAPSHOT" && e.activityType === "zarg.nav" && e.seq > s.seq)
    return { ...s, seq: e.seq, nav: ((e.content as { items?: ReadonlyArray<NavItem> } | undefined)?.items ?? []) }
  if (e.type === "ACTIVITY_SNAPSHOT" && e.activityType === "zarg.panels" && e.seq > s.seq)
    return { ...s, seq: e.seq, panels: ((e.content as { panels?: ReadonlyArray<Panel> } | undefined)?.panels ?? []) }
  if (e.type === "CUSTOM" && e.name === "zarg.navigate" && e.seq > s.seq) {
    const v = e.value as { kind?: unknown; view?: unknown; at?: unknown }
    if (v.kind !== "tile" && v.kind !== "sheet") return { ...s, seq: e.seq }
    return { ...s, seq: e.seq, navigate: { seq: e.seq, kind: v.kind, view: String(v.view), at: Number(v.at ?? 0) } }
  }
  if (e.threadId !== s.threadId || e.seq <= s.seq) return s
  const t: ThreadState = { ...s, seq: e.seq }
  // Views are their own activities: they never reach the agents tree below.
  if (isViewEvent(e as never)) return { ...t, views: reduceView(t.views ?? {}, e as never) }
  switch (e.type) {
    case "RUN_STARTED": {
      // A new run means the core took the answer (or message): the question goes. One still open comes
      // back with this run's interrupt.
      const { error: _, pendingInquiry: __, ...rest } = t
      return { ...rest, status: "running" }
    }
    case "RUN_FINISHED": {
      const outcome = e.outcome as { type: string; interrupts?: ReadonlyArray<Record<string, any>> } | undefined
      const i = outcome?.type === "interrupt" ? outcome.interrupts?.[0] : undefined
      const { pendingInquiry: _, ...rest } = t
      if (i === undefined) return { ...rest, status: "idle" }
      const meta = (i.metadata ?? {}) as { options?: ReadonlyArray<Option>; allowOther?: boolean; otherLabel?: string; about?: ReadonlyArray<string>; kind?: unknown }
      return {
        ...rest,
        status: "waiting",
        pendingInquiry: {
          id: String(i.id),
          question: String(i.message ?? ""),
          options: meta.options ?? [],
          allowOther: meta.allowOther ?? true,
          ...(meta.otherLabel !== undefined ? { otherLabel: meta.otherLabel } : {}),
          ...(meta.kind === "grant" ? { kind: "grant" as const } : {}),
          about: meta.about ?? [],
        },
      }
    }
    case "RUN_ERROR":
      return { ...t, status: "error", error: { message: String(e.message), ...(e.code !== undefined ? { code: String(e.code) } : {}) } }
    case "TEXT_MESSAGE_START":
      return { ...t, messages: [...t.messages, { id: String(e.messageId), role: e.role === "user" ? "user" : "assistant", text: "" }] }
    case "TEXT_MESSAGE_CONTENT":
      return { ...t, messages: t.messages.map((m) => (m.id === e.messageId ? { ...m, text: m.text + String(e.delta) } : m)) }
    case "ACTIVITY_SNAPSHOT": {
      const own = (e.content as { rlms?: ThreadState["rlms"] } | undefined)?.rlms ?? {}
      const streams = { ...t.streams, [String(e.messageId)]: own }
      // Only the driver's own tree starting over is a new tree (its RLM ids start over).
      const fresh = Object.keys(own).length === 0 && e.messageId === `${t.threadId}-activity`
      // A fresh driver tree starts its RLM ids over: archive marks on the old ones (no plugin prefix) would hide the new.
      const archived = fresh && t.archived !== undefined ? Object.fromEntries(Object.entries(t.archived).filter(([id]) => id.includes(":"))) : t.archived
      return { ...t, streams, rlms: merged(streams), trees: fresh ? t.trees + 1 : t.trees, ...(archived !== undefined ? { archived } : {}) }
    }
    case "CUSTOM": {
      if (e.name === "zarg.archive") {
        const v = e.value as { archive?: ReadonlyArray<string>; reason?: unknown; at?: unknown; restore?: ReadonlyArray<string>; delete?: ReadonlyArray<string> }
        const archived: Record<string, { reason: string; at: number }> = { ...t.archived }
        for (const id of v.archive ?? []) archived[id] = { reason: String(v.reason ?? "archived"), at: Number(v.at ?? 0) }
        for (const id of v.restore ?? []) delete archived[id]
        return { ...t, archived, ...(v.delete !== undefined ? { deleted: [...new Set([...(t.deleted ?? []), ...v.delete])] } : {}) }
      }
      return e.name === "zarg.yolo" ? { ...t, yolo: (e.value as { on?: unknown } | undefined)?.on === true } : t
    }
    case "ACTIVITY_DELTA": {
      const id = String(e.messageId)
      const streams = { ...t.streams, [id]: patchRlms(t.streams?.[id] ?? {}, (e.patch as ReadonlyArray<Patch>) ?? []) }
      return { ...t, streams, rlms: merged(streams) }
    }
    default:
      return t
  }
}
