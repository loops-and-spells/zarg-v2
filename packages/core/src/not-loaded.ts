import { Effect, Stream } from "effect"
import type { Thread } from "@zarg/agent-host"
import * as E from "./events"
import type { ThreadLog } from "./log"

/** The thread main is when zarg could not load: every run says why, and the core keeps serving. */
export const notLoaded = (log: ThreadLog, id: string, focus: ReadonlyArray<string>, why: string): Effect.Effect<Thread> =>
  Effect.succeed({
    id,
    focus,
    run: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const from = log.all().at(-1)?.seq ?? 0
          yield* log.append(id, E.runStarted(id, input.runId))
          for (const d of E.textMessage(`zarg-${crypto.randomUUID()}`, "assistant", `zarg is not loaded: ${why}`)) yield* log.append(id, d)
          yield* log.append(id, E.runFinished(id, input.runId))
          return Stream.fromIterable(log.all().filter((e) => e.threadId === id && e.seq > from))
        }),
      ),
    wake: Effect.void,
    stop: Effect.void,
    ask: () => Effect.succeed({ choice: "deny" }),
    status: () => "idle",
  })
