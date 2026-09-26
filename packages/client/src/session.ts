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
  /** Stop the thread's current work. */
  readonly stop: () => void
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

  const follow = (attempt: number): Effect.Effect<void> =>
    Stream.runForEach(opts.client.stream(state.thread.seq), (e) =>
      Effect.sync(() => set({ ...state, thread: reduce(state.thread, e), core: "up" })),
    ).pipe(
      Effect.catch((e) => Effect.succeed(e.message)),
      Effect.flatMap((problem) =>
        attempt < RETRIES
          ? Effect.andThen(Effect.sleep(200 * (attempt + 1)), follow(attempt + 1))
          : Effect.sync(() => set({ ...state, core: "down", notice: `core stopped${typeof problem === "string" ? `: ${problem}` : ""}` })),
      ),
    )

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
    stop: () => fork(opts.client.stop(opts.threadId).pipe(Effect.catch((e) => Effect.sync(() => set({ ...state, notice: e.message }))))),
    close: () => {
      for (const f of fibers) Effect.runFork(Fiber.interrupt(f))
      listeners.clear()
    },
  }
}
