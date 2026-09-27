import { Effect } from "effect"
import type { Rlm } from "@zarg/rlm"
import * as E from "./events"
import type { ThreadLog } from "./log"

/**
 * The RLM tree a thread shows (ACTIVITY_SNAPSHOT / ACTIVITY_DELTA) and its transcript. `prefix` keeps ids
 * apart when several independent RLM runs share one thread (the reconcile threads: one run per card).
 */
// The agents pane shows what an RLM was asked; the full task (often pages of context) stays in the transcript.
const TASK_MAX = 200
const headline = (task: string) => (task.split("\n")[0] ?? "").slice(0, TASK_MAX)

export const makeActivity = (log: ThreadLog, threadId: string) => {
  const nodes = new Map<string, Record<string, unknown>>()
  const messageId = `${threadId}-activity`
  const observe = (e: Rlm.RlmEvent, prefix = "") => {
    const id = `${prefix}${e.id}`
    // Transcripts get what each RLM was asked and did; the activity tree gets its shape and status.
    if (e.type === "step") {
      const { type, id: _, ...rest } = e
      Effect.runSync(log.transcript(threadId, { type, rlm: id, ...rest }))
      return
    }
    if (e.type === "start") Effect.runSync(log.transcript(threadId, { type: "start", rlm: id, parent: e.parent !== undefined ? `${prefix}${e.parent}` : null, preset: e.preset, task: e.task }))
    const prev = nodes.get(id) ?? {}
    const next: Record<string, unknown> =
      e.type === "start"
        ? { id, parent: e.parent !== undefined ? `${prefix}${e.parent}` : null, preset: e.preset, task: headline(e.task), scope: e.scope, depth: e.depth, turns: 0, budget: e.budget.turns, status: "running", decisions: [] }
        : e.type === "turn"
          ? { ...prev, turns: e.turn, tokens: e.tokens }
          : e.type === "atomize"
            ? { ...prev, decisions: [...((prev.decisions as Array<unknown>) ?? []), { kind: "atomize", atomic: e.atomic, criteria: e.criteria }] }
            : e.type === "plan"
              ? { ...prev, plan: e.children }
              : e.ok
                ? { ...prev, status: "done", turns: e.turns, tokens: e.tokens }
                : { ...prev, status: e.kind === "stopped" ? "stopped" : "failed", error: e.message }
    nodes.set(id, next)
    // JSON Pointer: escape "~" and "/" so the id stays one path segment.
    const segment = id.replaceAll("~", "~0").replaceAll("/", "~1")
    Effect.runSync(log.append(threadId, E.activityDelta(messageId, [{ op: "add", path: `/rlms/${segment}`, value: next }])))
  }
  return {
    observe,
    /** The whole tree as a snapshot event (sent at the start of each run). */
    snapshot: () => E.activitySnapshot(messageId, { rlms: Object.fromEntries(nodes) }),
    /** Start a fresh tree (a new driver item, a new pass). */
    reset: () => {
      nodes.clear()
      return E.activitySnapshot(messageId, { rlms: {} })
    },
  }
}
