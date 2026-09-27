import { Effect } from "effect"
import type { Rlm } from "@zarg/rlm"
import * as E from "./events"
import { redactValues, type ThreadLog } from "./log"
import { RLM_LAYOUT, rlmLines } from "./rlm-view"
import type { ViewStore } from "./views"

/**
 * The RLM tree a thread shows (ACTIVITY_SNAPSHOT / ACTIVITY_DELTA) and its transcript. `prefix` keeps ids
 * apart when several independent RLM runs share one thread (the reconcile threads: one run per card).
 */
// The agents pane shows what an RLM was asked; the full task (often pages of context) stays in the transcript.
// Redact before cutting: a cut through a secret would no longer match it.
const TASK_MAX = 200
// The RLM view's Task section: the task and its current cell, clipped (it is resent on every step).
const VIEW_TASK_MAX = 2_000
const VIEW_CELL_MAX = 4_000
const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text)
const headline = (task: string) => (task.split("\n")[0] ?? "").slice(0, TASK_MAX)

/**
 * `messageId`: the stream these agents travel in; another stream (a rehearsal) shares the thread's pane without
 * resetting it. `views`: when given, each RLM also draws its view (status, task and current cell, history).
 */
export const makeActivity = (log: ThreadLog, threadId: string, messageId = `${threadId}-activity`, views?: ViewStore) => {
  const nodes = new Map<string, Record<string, unknown>>()
  const tasks = new Map<string, string>()
  const push = (rlm: string, record: Record<string, unknown>) => {
    if (views === undefined || !views.has(rlm)) return
    // Every value redacted before lines are clipped or JSON-stringified: a cut or escaped secret would slip past.
    const lines = rlmLines(redactValues(record, log.redact) as Record<string, unknown>)
    if (lines.length > 0) views.append(rlm, "history", lines)
  }
  const status = (rlm: string, n: Record<string, unknown>) => {
    if (views === undefined || !views.has(rlm)) return
    const turns = Number(n.turns ?? 0)
    const budget = Number(n.budget ?? 0)
    const state = String(n.status ?? "running")
    views.set(rlm, "status", {
      items: [
        { label: "turns", value: `${turns}/${budget}` },
        { label: "tokens", value: Number(n.tokens ?? 0).toLocaleString("en-US") },
        { label: "preset", value: String(n.preset ?? "") },
        { label: "state", value: state, tone: state === "failed" ? "error" : state === "done" ? "ok" : "normal" },
      ],
      progress: { done: turns, total: Math.max(budget, turns) },
    })
  }
  const observe = (e: Rlm.RlmEvent, prefix = "") => {
    const id = `${prefix}${e.id}`
    // Transcripts get what each RLM was asked and did; the activity tree gets its shape and status.
    // Records (service calls, clock reads) go to the transcript only, never to the activity tree or the wire.
    if (e.type === "record") {
      const { kind, ...rest } = e.record
      Effect.runSync(log.transcript(threadId, { type: kind, rlm: id, turn: e.turn, ...rest }))
      push(id, { type: kind, rlm: id, turn: e.turn, ...rest })
      return
    }
    if (e.type === "step") {
      const { type, id: _, ...rest } = e
      Effect.runSync(log.transcript(threadId, { type, rlm: id, ...rest }))
      push(id, { type, rlm: id, ...rest })
      // The task section shows the task, then the cell the RLM ran last.
      const last = e.cells.at(-1)
      if (last !== undefined && views?.has(id)) views.set(id, "task", { markdown: `${tasks.get(id) ?? ""}\n\n\`\`\`ts\n${clipText(log.redact(last.code), VIEW_CELL_MAX)}\n\`\`\`` })
      return
    }
    if (e.type === "model") {
      const { type, id: _, ...rest } = e
      Effect.runSync(log.transcript(threadId, { type, rlm: id, ...rest }))
      push(id, { type, rlm: id, ...rest })
      return
    }
    if (e.type === "atomize" || e.type === "extend") {
      const { type, id: _, ...rest } = e
      Effect.runSync(log.transcript(threadId, { type, rlm: id, ...rest }))
      push(id, { type, rlm: id, ...rest })
    }
    if (e.type === "plan") push(id, { type: "plan", children: e.children })
    if (e.type === "start") {
      Effect.runSync(log.transcript(threadId, { type: "start", rlm: id, parent: e.parent !== undefined ? `${prefix}${e.parent}` : null, preset: e.preset, task: e.task }))
      if (views !== undefined) {
        const task = clipText(log.redact(e.task), VIEW_TASK_MAX)
        tasks.set(id, task)
        views.start(id, RLM_LAYOUT)
        views.set(id, "task", { markdown: task })
        push(id, { type: "start", rlm: id, preset: e.preset, task: e.task })
      }
    }
    const prev = nodes.get(id) ?? {}
    if (e.type === "status") {
      // The agent draws its own row: no transcript line, only the pane.
      const row = { ...(e.progress !== undefined ? { progress: e.progress } : {}), ...(e.text !== undefined ? { text: log.redact(e.text) } : {}) }
      const next = { ...prev, row }
      nodes.set(id, next)
      const seg = id.replaceAll("~", "~0").replaceAll("/", "~1")
      Effect.runSync(log.append(threadId, E.activityDelta(messageId, [{ op: "add", path: `/rlms/${seg}`, value: next }])))
      return
    }
    const next: Record<string, unknown> =
      e.type === "start"
        ? { id, parent: e.parent !== undefined ? `${prefix}${e.parent}` : null, preset: e.preset, task: headline(log.redact(e.task)), scope: e.scope, depth: e.depth, turns: 0, budget: e.budget.turns, status: "running", decisions: [] }
        : e.type === "turn"
          ? { ...prev, turns: e.turn, tokens: e.tokens }
          : e.type === "atomize"
            ? { ...prev, decisions: [...((prev.decisions as Array<unknown>) ?? []), { kind: "atomize", atomic: e.atomic, criteria: e.criteria }] }
            : e.type === "extend"
              ? { ...prev, budget: e.turns, decisions: [...((prev.decisions as Array<unknown>) ?? []), { kind: "extend", extended: e.extended, turns: e.turns, confidence: e.confidence, reason: e.reason }] }
              : e.type === "plan"
              ? { ...prev, plan: e.children }
              : e.ok
                ? { ...prev, status: "done", turns: e.turns, tokens: e.tokens }
                : { ...prev, status: e.kind === "stopped" ? "stopped" : "failed", error: e.message }
    nodes.set(id, next)
    status(id, next)
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

/**
 * Agents a previous core left running (it exited mid-run: Ctrl-C, a crash) are marked stopped, so clients replaying
 * the log never show them as live. Work that can resume (a rehearse run) starts its agents afresh.
 */
export const closeStale = (log: ThreadLog) =>
  Effect.sync(() => {
    const streams = new Map<string, { threadId: string; nodes: Map<string, Record<string, unknown>> }>()
    for (const e of log.all()) {
      if ((e.type !== "ACTIVITY_SNAPSHOT" && e.type !== "ACTIVITY_DELTA") || e.activityType !== E.ACTIVITY_TYPE) continue
      const key = `${e.threadId}\u0000${String(e.messageId)}`
      if (e.type === "ACTIVITY_SNAPSHOT") {
        const rlms = ((e.content as { rlms?: Record<string, Record<string, unknown>> } | undefined)?.rlms ?? {})
        streams.set(key, { threadId: e.threadId, nodes: new Map(Object.entries(rlms)) })
        continue
      }
      const s = streams.get(key) ?? { threadId: e.threadId, nodes: new Map() }
      streams.set(key, s)
      for (const p of (e.patch as ReadonlyArray<{ op: string; path: string; value?: Record<string, unknown> }>) ?? []) {
        const m = /^\/rlms\/([^/]+)$/.exec(p.path)
        if (m === null) continue
        const id = m[1]!.replace(/~1/g, "/").replace(/~0/g, "~")
        if (p.op === "remove") s.nodes.delete(id)
        else if (p.value !== undefined) s.nodes.set(id, p.value)
      }
    }
    for (const [key, s] of streams) {
      const patch = [...s.nodes.entries()]
        .filter(([, n]) => n.status === "running")
        .map(([id, n]) => ({ op: "add", path: `/rlms/${id.replaceAll("~", "~0").replaceAll("/", "~1")}`, value: { ...n, status: "stopped", error: "zarg restarted" } }))
      if (patch.length > 0) Effect.runSync(log.append(s.threadId, E.activityDelta(key.split("\u0000")[1]!, patch)))
    }
  })
