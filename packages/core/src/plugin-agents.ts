import type { Layout } from "@zarg/view"
import type { Rlm } from "@zarg/rlm"
import { makeActivity } from "./activity"
import type { ThreadLog } from "./log"
import { DEFAULT_LAYOUT, threadViews } from "./views"

export type AgentEvent =
  | { readonly event: "start"; readonly id: string; readonly parent?: string; readonly title: string; readonly task: string; readonly view?: string }
  | { readonly event: "status"; readonly id: string; readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }
  | { readonly event: "step"; readonly id: string; readonly text: string }
  | { readonly event: "end"; readonly id: string; readonly ok: boolean; readonly message?: string }
  /** Data for a section of the agent's view (checked by the core against the declared layout). */
  | { readonly event: "set"; readonly id: string; readonly section: string; readonly data: unknown }
  | { readonly event: "append"; readonly id: string; readonly section: string; readonly lines: unknown }
  /** Ask for the developer's attention (a reason) or stop asking (no reason). */
  | { readonly event: "attention"; readonly id: string; readonly reason?: string }

const ID = /^[A-Za-z0-9._-]{1,64}$/

/**
 * A plugin's agents in a thread's agents pane: their own stream, ids `<plugin>:<id>`, `step` lines as history,
 * and their views (the plugin's declared layouts, found by `layoutOf`).
 */
export const pluginAgents = (log: ThreadLog, threadId: string, layoutOf: (plugin: string, view: string) => Layout | undefined = () => undefined) => {
  const streams = new Map<string, ReturnType<typeof makeActivity>>()
  const views = threadViews(log, threadId)
  return (plugin: string, e: AgentEvent) => {
    if (!ID.test(e.id) || ("parent" in e && e.parent !== undefined && !ID.test(e.parent))) throw new Error(`agent id "${e.id}" must be letters, digits, dot, dash or underscore`)
    let a = streams.get(plugin)
    if (a === undefined) streams.set(plugin, (a = makeActivity(log, threadId, `${threadId}-${plugin}-agents`)))
    const id = `${plugin}:${e.id}`
    if (e.event === "set") return views.set(id, e.section, e.data)
    if (e.event === "attention") return a.attention(id, typeof e.reason === "string" && e.reason.length > 0 ? e.reason.slice(0, 80) : undefined)
    if (e.event === "append") return views.append(id, e.section, e.lines)
    if (e.event === "start") {
      const layout = e.view === undefined ? DEFAULT_LAYOUT : layoutOf(plugin, e.view)
      if (layout === undefined) throw new Error(`plugin ${plugin} declares no view ${e.view}`)
      views.start(id, layout)
    }
    if (e.event === "step") {
      const first = views.layout(id)?.sections.find((s) => s.kind === "log")
      if (first !== undefined) views.append(id, first.id, [{ text: e.text }])
    }
    const ev: Rlm.RlmEvent =
      e.event === "start"
        ? { type: "start", id, parent: e.parent === undefined ? undefined : `${plugin}:${e.parent}`, preset: e.title, task: e.task, scope: {}, depth: e.parent === undefined ? 0 : 1, budget: { turns: 1, tokens: 0, wallMs: 0 } }
        : e.event === "status"
          ? { type: "status", id, ...(e.progress !== undefined ? { progress: e.progress } : {}), ...(e.text !== undefined ? { text: e.text } : {}) }
          : e.event === "step"
            ? { type: "step", id, turn: 0, text: e.text, cells: [] }
            : e.ok
              ? { type: "end", id, ok: true, turns: 1, tokens: 0 }
              : { type: "end", id, ok: false, kind: "result", message: e.message ?? "failed" }
    a.observe(ev)
  }
}
