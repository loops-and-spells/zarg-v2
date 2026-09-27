import { Cause, Deferred, Effect, Exit, Fiber, Semaphore, Stream } from "effect"
import type { AgendaItem } from "@zarg/plugin/server"
import type { Answer, Asker, Question, Rlm, Scope } from "@zarg/rlm"
import { makeActivity } from "./activity"
import * as E from "./events"
import type { Interrupt } from "@ag-ui/core"
import type { WireEvent } from "./events"
import type { ThreadLog } from "./log"

export const WHAT_NEXT =
  "The agenda is empty. Ask the developer what to work on next, with options drawn from the graph (unexplored branches, missing failure cases, the next journey). Decide the options yourself from Graph.render and Graph.agenda; no research children for this."

/** Appended to every driver task: its result is a message to the developer. */
export const REPLY_RULE =
  "Finish with `yield* Rlm.done({ value })`, where value is one or two sentences to the developer about what you did or found. No card renders, no ids-only lists."

/** The longest reply shown; longer results are cut. */
const REPLY_MAX = 600

/** A resume or a typed message, as a run brings it in. */
export interface RunInput {
  readonly runId: string
  /** The newest user message, when the developer typed something. */
  readonly message?: string
  readonly resume?: ReadonlyArray<{ readonly interruptId: string; readonly payload?: unknown }>
}

export interface ThreadDeps {
  readonly id: string
  readonly focus: ReadonlyArray<string>
  readonly log: ThreadLog
  readonly agenda: (focus: ReadonlySet<string> | undefined) => Effect.Effect<ReadonlyArray<AgendaItem>, unknown>
  /** Runs one driver RLM; the thread supplies the Asker its Inquire service must use and an observer for activity. */
  readonly driver: (spec: Rlm.RlmSpec, asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.RlmOutcome, Rlm.RlmError>
  /** Gherkin text for these node ids within the driver's scope, put in its task so its first turn need not fetch it. */
  readonly render?: (ids: ReadonlyArray<string>, scope: Scope) => Effect.Effect<string, unknown>
}

// The agenda the driver sees up front; the rest it can still read with Graph.agenda.
const AGENDA_SHOWN = 10
// A hub state can touch many cards: the seeded render is cut, and the driver can ask for the rest.
const RENDER_MAX = 4_000
const cut = (text: string) => (text.length > RENDER_MAX ? `${text.slice(0, RENDER_MAX)}\n… (cut; Graph.render({ focus }) shows the rest)` : text)

interface Pending {
  readonly id: string
  readonly question: Question
  readonly answer: Deferred.Deferred<Answer>
  /** The AG-UI interrupt, kept to send again to a run that brings no answer. */
  readonly interrupt: Interrupt
}

/** One driver thread: a loop of driver RLMs, one per agenda item, paused at inquiries. */
export const makeThread = (deps: ThreadDeps) =>
  Effect.gen(function* () {
    const { log, id: threadId } = deps
    let runId = ""
    /** True from RUN_STARTED until this run's RUN_FINISHED or RUN_ERROR. */
    let open = false
    let loop: Fiber.Fiber<void, never> | undefined
    let loopGen = 0
    // run, stop and a new question change the same state; one at a time.
    const lock = yield* Semaphore.make(1)
    const locked = Semaphore.withPermits(lock, 1)
    let pending: Pending | undefined
    let paused: Deferred.Deferred<void> | undefined
    const recent: Array<string> = []
    // Messages the developer sent while the driver worked: the next item answers them, before the agenda.
    const inbox: Array<string> = []
    const emit = (d: E.Draft) => {
      if (d.type === "RUN_FINISHED" || d.type === "RUN_ERROR") open = false
      return log.append(threadId, d)
    }
    const emitAll = (ds: ReadonlyArray<E.Draft>) => Effect.forEach(ds, emit, { discard: true })
    const note = (role: "assistant" | "user", text: string) => {
      recent.push(`${role === "user" ? "developer" : "driver"}: ${text}`)
      if (recent.length > 8) recent.shift()
      // Random ids: a restarted core must not reuse ids already in the thread's log.
      return emitAll(E.textMessage(`${threadId}-${crypto.randomUUID()}`, role, text))
    }

    // Inquire: park the cell and end the current run with an interrupt; a later run's resume answers it.
    const asker: Asker = {
      ask: (question) =>
        Effect.gen(function* () {
          const answer = yield* Deferred.make<Answer>()
          const id = `inq-${crypto.randomUUID()}`
          const interrupt = {
              id,
              reason: "inquiry",
              message: question.question,
              metadata: { options: question.options, allowOther: question.allowOther ?? true, about: question.about ?? [] },
              responseSchema: {
                oneOf: [
                  { type: "object", properties: { choice: { enum: question.options.map((o) => o.id) } }, required: ["choice"] },
                  { type: "object", properties: { other: { type: "string" } }, required: ["other"] },
                ],
              },
            } as unknown as Interrupt
          yield* locked(
            Effect.gen(function* () {
              pending = { id, question, answer, interrupt }
              yield* emit(E.runInterrupted(threadId, runId, interrupt))
            }),
          )
          return yield* Deferred.await(answer)
        }),
    }

    // RLM events become one activity message: the tree of RLMs working for this thread.
    const activity = makeActivity(log, threadId)
    const observe = (e: Rlm.RlmEvent) => activity.observe(e)

    const scope: Scope = deps.focus.length > 0 ? { graph: { focus: deps.focus, k: 2 } } : {}
    const focusSet = deps.focus.length > 0 ? new Set(deps.focus) : undefined

    const body = Effect.gen(function* () {
      let lastItem = ""
      let passes = 0
      while (true) {
        const said = inbox.splice(0)
        const items = said.length > 0 ? [] : yield* deps.agenda(focusSet).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AgendaItem>))
        const item = items[0]
        passes = item !== undefined && item.id === lastItem ? passes + 1 : 1
        lastItem = item?.id ?? ""
        // The same item still open after two passes: ask what next instead of looping on it.
        const stuck = item !== undefined && passes > 2
        const around =
          item !== undefined && !stuck && item.about.length > 0 && deps.render !== undefined
            ? yield* deps.render(item.about, scope).pipe(
                Effect.map(cut),
                // Seeding is a shortcut: any failure, even a plugin defect, just leaves the cards out.
                Effect.catchCause(() => Effect.succeed("")),
              )
            : ""
        const task = [
          said.length > 0
            ? `The developer said: ${said.map((m) => JSON.stringify(m)).join(" then ")}\nAnswer them directly. If a choice is needed, ask with Inquire.ask (options, one recommended).`
            : item === undefined || stuck
              ? WHAT_NEXT
              : `${item.title}\n${item.detail}\nPropose how to resolve it and ask the developer with Inquire.ask before changing the graph.`,
          stuck ? `Note: "${item!.title}" is still open after two passes; mention it among the options.` : "",
          around.length > 0 ? `The cards around it (Graph.render of ${item!.about.join(", ")}):\n${around}` : "",
          items.length > 0
            ? `Open agenda (${items.length}):\n${items
                .slice(0, AGENDA_SHOWN)
                .map((i) => `- ${i.title}${i.about.length > 0 ? ` [${i.about.join(", ")}]` : ""}`)
                .join("\n")}`
            : "",
          recent.length > 0 ? `Recent conversation:\n${recent.join("\n")}` : "",
          REPLY_RULE,
        ]
          .filter((x) => x.length > 0)
          .join("\n\n")
        // Each item gets a fresh driver RLM, whose ids start over: start a fresh tree.
        yield* emit(activity.reset())
        const outcome = yield* Effect.exit(deps.driver({ task, preset: "driver", scope }, asker, observe))
        if (Exit.isSuccess(outcome)) {
          const reply = String(outcome.value.value)
          yield* note("assistant", reply.length > REPLY_MAX ? `${reply.slice(0, REPLY_MAX)}…` : reply)
          continue
        }
        const err = outcome.cause.reasons.find((r) => r._tag === "Fail")?.error
        // Set up the pause before announcing the error: the next run may arrive as soon as it is sent.
        const wait = yield* Deferred.make<void>()
        paused = wait
        yield* emit(E.runError(err?.message ?? "the driver failed", err?.kind ?? "error"))
        yield* Deferred.await(wait)
      }
    })

    // A loop that dies of a defect ends the open run with RUN_ERROR and clears itself, so the next run starts a new one.
    const startLoop = Effect.gen(function* () {
      if (loop !== undefined) return
      const gen = ++loopGen
      const guarded = (body as Effect.Effect<void>).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (loopGen !== gen) return
            loop = undefined
            pending = undefined
            paused = undefined
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              const e = Cause.squash(exit.cause)
              yield* Effect.exit(emit(E.runError(`the thread loop failed: ${e instanceof Error ? e.message : String(e)}`, "internal")))
            }
          }),
        ),
      )
      loop = yield* Effect.forkDetach(guarded)
    })

    const run = (input: RunInput): Stream.Stream<WireEvent> =>
      Stream.unwrap(
        locked(Effect.gen(function* () {
          const from = log.all().at(-1)?.seq ?? 0
          // A run still open (the driver was working, no question yet) ends here; this run takes over.
          if (open) yield* emit(E.runFinished(threadId, runId))
          runId = input.runId
          open = true
          yield* emit(E.runStarted(threadId, runId))
          yield* emit(activity.snapshot())
          const resume = input.resume?.[0]
          if (resume !== undefined && pending !== undefined && resume.interruptId === pending.id) {
            const payload = (resume.payload ?? {}) as { choice?: string; other?: string }
            const chosen = pending.question.options.find((o) => o.id === payload.choice)
            const answer: Answer = payload.choice !== undefined ? { choice: payload.choice } : { other: String(payload.other ?? "") }
            const p = pending
            pending = undefined
            yield* note("user", chosen?.label ?? String(payload.other ?? ""))
            yield* Deferred.succeed(p.answer, answer)
          } else if (input.message !== undefined && pending !== undefined) {
            // Interjection: the message answers the pending question; the question is recorded as dropped.
            const p = pending
            pending = undefined
            yield* note("user", input.message)
            yield* note("assistant", `(dropped question: ${p.question.question})`)
            yield* Deferred.succeed(p.answer, { other: input.message, interjected: true } as Answer)
          } else {
            // A resume for an interrupt this core does not know (e.g. after a restart) counts as a message.
            const text = input.message ?? (resume !== undefined ? String((resume.payload as { other?: string; choice?: string })?.other ?? (resume.payload as { choice?: string })?.choice ?? "") : undefined)
            if (text !== undefined && text.length > 0) {
              yield* note("user", text)
              inbox.push(text)
            }
          }
          if (paused !== undefined) {
            const p = paused
            paused = undefined
            yield* Deferred.succeed(p, undefined)
          }
          // Still waiting on a question this run did not answer (a client that just attached): ask it again.
          if (pending !== undefined) yield* emit(E.runInterrupted(threadId, runId, pending.interrupt))
          yield* startLoop
          const mine = runId
          return log.stream(from, threadId).pipe(
            Stream.takeUntil((e) => (e.type === "RUN_FINISHED" && e.runId === mine) || e.type === "RUN_ERROR"),
          )
        })),
      )

    /** Stop the thread's current work: the running RLM and its children are interrupted. */
    const stop = locked(
      Effect.gen(function* () {
        const f = loop
        loopGen++
        pending = undefined
        paused = undefined
        if (f !== undefined) yield* Fiber.interrupt(f)
        loop = undefined
        // With no run open (waiting on a question, or idle), the stop note gets a run of its own.
        if (!open) {
          runId = `stop-${crypto.randomUUID()}`
          open = true
          yield* emit(E.runStarted(threadId, runId))
        }
        yield* note("assistant", "(stopped)")
        yield* emit(E.runStopped(threadId, runId))
      }),
    )

    return { id: threadId, focus: deps.focus, run, stop, status: () => (pending ? "waiting" : loop ? "running" : "idle") }
  })

export type Thread = Effect.Success<ReturnType<typeof makeThread>>
