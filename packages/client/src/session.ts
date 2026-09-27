import { Effect, Fiber, Stream } from "effect"
import type { Client, RunRequest } from "./client"
import type { Answer } from "./events"
import { initial, reduce, type ThreadState } from "./state"

export interface SessionState {
  readonly thread: ThreadState
  /** "down" once the core stops answering (it exited, or the socket is gone). */
  readonly core: "up" | "down"
  /** The last transport problem (a refused run, a lost stream), shown to the developer. */
  readonly notice?: string
}

export interface Session {
  readonly state: () => SessionState
  /** Called after every state change; returns an unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
  /** Follow the core's event stream (history first) and start or resume the thread's loop. */
  readonly start: () => void
  /** Answer the pending inquiry. Does nothing when none is pending. */
  readonly answer: (answer: Answer) => void
  /** Send a message; while an inquiry is pending the core takes it as an interjection. */
  readonly send: (text: string) => void
  /** A slash command typed in the input (`/reconcile`); its outcome shows as a notice. */
  readonly command: (text: string) => void
  /** Stop the thread's current work. */
  readonly stop: () => void
  /** One agent's transcript lines, for its history view; empty when the core cannot answer. */
  readonly history: (rlm: string) => Promise<ReadonlyArray<Record<string, unknown>>>
  /** Stop following the core. */
  readonly close: () => void
}

/** Reconnect attempts after the event stream breaks, before the core counts as stopped. */
const RETRIES = 3

/**
 * One thread as a UI sees it. All state comes from the core's event stream (`/stream`, replayed from
 * the start, then live), so history, other clients' runs and this client's runs arrive the same way.
 * Posting a run only sends input; its own SSE copy is drained.
 */
export const makeSession = (opts: { readonly client: Client; readonly threadId: string; readonly focus?: ReadonlyArray<string> }): Session => {
  let state: SessionState = { thread: initial(opts.threadId), core: "up" }
  const listeners = new Set<() => void>()
  const set = (next: SessionState) => {
    state = next
    for (const l of listeners) l()
  }
  const fibers = new Set<Fiber.Fiber<unknown, unknown>>()
  const fork = <A, E>(effect: Effect.Effect<A, E>) => {
    const f = Effect.runFork(effect)
    fibers.add(f)
    f.addObserver(() => fibers.delete(f))
  }

  const follow = (attempt: number): Effect.Effect<void> => {
    // A connection that delivered events was healthy: the next break starts counting from zero.
    let received = false
    return Stream.runForEach(opts.client.stream(state.thread.seq), (e) =>
      Effect.sync(() => {
        received = true
        set({ ...state, thread: reduce(state.thread, e), core: "up" })
      }),
    ).pipe(
      Effect.catch((e) => Effect.succeed(e.message)),
      Effect.flatMap((problem) => {
        if (received) attempt = 0
        return attempt < RETRIES
          ? Effect.andThen(Effect.sleep(200 * (attempt + 1)), follow(attempt + 1))
          : Effect.sync(() => set({ ...state, core: "down", notice: `core stopped${typeof problem === "string" ? `: ${problem}` : ""}` }))
      }),
    )
  }

  const post = (r: Omit<RunRequest, "threadId" | "focus">) =>
    fork(
      Stream.runDrain(opts.client.run({ threadId: opts.threadId, ...(opts.focus ? { focus: opts.focus } : {}), ...r })).pipe(
        Effect.catch((e) => Effect.sync(() => set({ ...state, notice: e.message }))),
      ),
    )

  return {
    state: () => state,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    start: () => {
      fork(follow(0))
      post({})
    },
    answer: (answer) => {
      const pending = state.thread.pendingInquiry
      if (pending !== undefined) post({ answer: { interruptId: pending.id, answer } })
    },
    send: (text) => {
      if (text.trim().length > 0) post({ message: text })
    },
    command: (text) => {
      const [name = "", ...args] = text.trim().split(/\s+/)
      if (name === "/yolo") {
        // `/yolo [on|off] [plugin=<name>]`: a bare /yolo turns it on.
        const on = args[0] !== "off"
        const plugin = args.find((a) => a.startsWith("plugin="))?.slice("plugin=".length)
        fork(
          opts.client.yolo(on, plugin).pipe(
            Effect.map(() =>
              on
                ? `YOLO is on${plugin ? ` for ${plugin}` : ""}: ${plugin ? "it uses every scope it declares" : "plugins use every scope they declare, and agents read outside the repository,"} without asking. Nothing is saved; /yolo off asks again.`
                : `YOLO is off${plugin ? ` for ${plugin}` : ""}: plugins ask before using a scope you have not granted.`,
            ),
            Effect.catch((e) => Effect.succeed(e.message)),
            Effect.flatMap((notice) => Effect.sync(() => set({ ...state, notice }))),
          ),
        )
        return
      }
      if (name === "/rehearse") {
        const strategy = args.find((a) => a === "edge-pair" || a === "teleport") as "edge-pair" | "teleport" | undefined
        const focus = args.find((a) => a.startsWith("focus="))?.slice("focus=".length).split(",").filter((x) => x.length > 0)
        fork(
          opts.client.rehearse(strategy, focus).pipe(
            Effect.map((a) =>
              a.refused !== undefined
                ? `Rehearse did not start: ${a.refused}`
                : `Rehearse run ${a.run} started: ${a.stories} stories, ${a.steps} steps, testers: ${(a.personas ?? []).join(", ") || "none"}. Watch it in the agents pane (Tab).`,
            ),
            Effect.catch((e) => Effect.succeed(e.message)),
            Effect.flatMap((notice) => Effect.sync(() => set({ ...state, notice }))),
          ),
        )
        return
      }
      if (name !== "/reconcile") {
        set({ ...state, notice: `unknown command: ${name} (try /reconcile, /rehearse or /yolo)` })
        return
      }
      fork(
        opts.client.reconcile().pipe(
          Effect.map((a) =>
            !a.on
              ? `Reconcile stays off: ${a.reason ?? "unknown reason"}`
              : (a.pending ?? 0) > 0
                ? `Reconcile is on for this session; a pass is starting (${a.pending} card${a.pending === 1 ? "" : "s"}).`
                : "Reconcile is on for this session; nothing to reconcile.",
          ),
          Effect.catch((e) => Effect.succeed(e.message)),
          Effect.flatMap((notice) => Effect.sync(() => set({ ...state, notice }))),
        ),
      )
    },
    history: (rlm) => Effect.runPromise(opts.client.history(opts.threadId, rlm).pipe(Effect.orElseSucceed(() => []))),
    stop: () => fork(opts.client.stop(opts.threadId).pipe(Effect.catch((e) => Effect.sync(() => set({ ...state, notice: e.message }))))),
    close: () => {
      for (const f of fibers) Effect.runFork(Fiber.interrupt(f))
      listeners.clear()
    },
  }
}
