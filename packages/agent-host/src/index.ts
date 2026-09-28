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
  readonly findings: { readonly chosen: unknown; readonly firstParty: (plugin: string) => boolean }
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
