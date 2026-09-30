import type { BaseEvent } from "@ag-ui/core"
import type { Effect, Stream } from "effect"

/** An AG-UI event as the core sends it on a thread. */
export type WireEvent = BaseEvent & { readonly threadId: string; readonly seq: number; readonly [key: string]: unknown }

/** A resume or a typed message, as a run brings it in. */
export interface RunInput {
  readonly runId: string
  /** The newest user message, when the operator typed something. */
  readonly message?: string
  readonly resume?: ReadonlyArray<{ readonly interruptId: string; readonly payload?: unknown }>
}

/** A conversation thread the core serves (`/runs`, `/threads/:id/stop`); a trusted agent makes them. */
export interface Thread {
  readonly id: string
  readonly focus: ReadonlyArray<string>
  readonly run: (input: RunInput) => Stream.Stream<WireEvent>
  /** New work arrived: a paused loop takes up the agenda again. */
  readonly wake: Effect.Effect<void>
  readonly stop: Effect.Effect<void>
  readonly status: () => "idle" | "running" | "waiting"
  /** Its questions are inbox topics: the operator's answer or reply to one, from the inbox. */
  readonly inbox?: {
    readonly answered: (topic: InboxTopicRef, reply: { readonly answer?: string; readonly text?: string }) => Effect.Effect<void>
    readonly replied: (topic: InboxTopicRef, text: string) => Effect.Effect<void>
  }
}

/** What a thread needs of an inbox topic to act on its answer: its id, its question and its answers. */
export interface InboxTopicRef {
  readonly id: string
  readonly title: string
  readonly answers?: ReadonlyArray<{ readonly id: string; readonly label: string }>
}

/** The inbox as a trusted agent uses it: raise its own topics (blocking, durable), answer, settle and note them. */
export interface AgentInbox {
  readonly post: (t: {
    readonly kind: string
    readonly title: string
    readonly why: string
    readonly about?: ReadonlyArray<string>
    readonly answers?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly recommended?: boolean; readonly why?: string }>
    readonly text?: { readonly placeholder: string }
    readonly key?: string
  }) => Effect.Effect<string, unknown>
  readonly answer: (id: string, reply: { readonly answer?: string; readonly text?: string }, by: string) => Effect.Effect<unknown, unknown>
  readonly settle: (id: string, why: string) => Effect.Effect<unknown, unknown>
  readonly message: (id: string, by: string, text: string) => Effect.Effect<unknown, unknown>
  /** One of this agent's topics by its key (after a restart, the question an old answer is for). */
  readonly find: (key: string) => Effect.Effect<{ readonly id: string; readonly title: string; readonly state: string; readonly answers?: ReadonlyArray<{ readonly id: string; readonly label: string }> } | undefined, unknown>
}

export interface AgendaEntry {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly about: ReadonlyArray<string>
  readonly priority: number
  readonly plugin?: string
}

/**
 * What the core gives a trusted agent. Services are the core's own; they are typed loosely here so this package
 * stays light, and the agent narrows each to the type it imports itself.
 */
export interface AgentHost {
  readonly root: string
  readonly roles: Readonly<Record<string, string>>
  readonly rlmSettings: unknown
  readonly model: unknown
  readonly decisions: unknown
  readonly plugins: unknown
  readonly store: unknown
  readonly log: unknown
  readonly sensitive: ReadonlyArray<unknown>
  /** The agenda for the driver: reconcile's items and the plugins' items (the host's own plugin-* items left out). */
  readonly agenda: (focus: ReadonlySet<string> | undefined) => Effect.Effect<ReadonlyArray<AgendaEntry>, unknown>
  /** The gate for reads outside the repository (the core asks the operator itself). */
  readonly outsideReads: unknown
  /** The operator's inbox, for this agent's own questions. */
  readonly inbox?: AgentInbox
  /** Panels this agent opens (its message bar): shown by every client until closed. */
  readonly panels: {
    readonly open: (p: { readonly name: string; readonly view: string; readonly scope: "agent" | "shell"; readonly edge: "top" | "bottom" | "right"; readonly size: number; readonly input: "none" | "onFocus" }) => void
  }
}

/** A trusted agent: imported into the core by path from zarg's own packages, started once. */
export interface TrustedAgent {
  readonly name: string
  readonly start: (host: AgentHost) => Effect.Effect<{ readonly makeThread: (id: string, focus: ReadonlyArray<string>) => Effect.Effect<Thread> }, unknown>
}

export const defineTrustedAgent = (a: TrustedAgent): TrustedAgent => a
