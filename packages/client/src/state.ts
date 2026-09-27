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
  readonly about: ReadonlyArray<string>
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
  if (e.threadId !== s.threadId || e.seq <= s.seq) return s
  const t: ThreadState = { ...s, seq: e.seq }
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
      const meta = (i.metadata ?? {}) as { options?: ReadonlyArray<Option>; allowOther?: boolean; otherLabel?: string; about?: ReadonlyArray<string> }
      return {
        ...rest,
        status: "waiting",
        pendingInquiry: {
          id: String(i.id),
          question: String(i.message ?? ""),
          options: meta.options ?? [],
          allowOther: meta.allowOther ?? true,
          ...(meta.otherLabel !== undefined ? { otherLabel: meta.otherLabel } : {}),
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
      return { ...t, streams, rlms: merged(streams), trees: fresh ? t.trees + 1 : t.trees }
    }
    case "CUSTOM":
      return e.name === "zarg.yolo" ? { ...t, yolo: (e.value as { on?: unknown } | undefined)?.on === true } : t
    case "ACTIVITY_DELTA": {
      const id = String(e.messageId)
      const streams = { ...t.streams, [id]: patchRlms(t.streams?.[id] ?? {}, (e.patch as ReadonlyArray<Patch>) ?? []) }
      return { ...t, streams, rlms: merged(streams) }
    }
    default:
      return t
  }
}
