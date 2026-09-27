import type { Rlm } from "@zarg/rlm"
import { makeActivity } from "./activity"
import type { ThreadLog } from "./log"

export type AgentEvent =
  | { readonly event: "start"; readonly id: string; readonly parent?: string; readonly title: string; readonly task: string }
  | { readonly event: "status"; readonly id: string; readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }
  | { readonly event: "step"; readonly id: string; readonly text: string }
  | { readonly event: "end"; readonly id: string; readonly ok: boolean; readonly message?: string }

const ID = /^[A-Za-z0-9._-]{1,64}$/

/** A plugin's agents in a thread's agents pane: their own stream, ids `<plugin>:<id>`, `step` lines as history. */
export const pluginAgents = (log: ThreadLog, threadId: string) => {
  const streams = new Map<string, ReturnType<typeof makeActivity>>()
  return (plugin: string, e: AgentEvent) => {
    if (!ID.test(e.id) || ("parent" in e && e.parent !== undefined && !ID.test(e.parent))) throw new Error(`agent id "${e.id}" must be letters, digits, dot, dash or underscore`)
    let a = streams.get(plugin)
    if (a === undefined) streams.set(plugin, (a = makeActivity(log, threadId, `${threadId}-${plugin}-agents`)))
    const id = `${plugin}:${e.id}`
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
