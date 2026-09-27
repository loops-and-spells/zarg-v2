import { Effect } from "effect"
import type { Layout, Surface } from "@zarg/view"
import type { Rlm } from "@zarg/rlm"
import { makeActivity } from "./activity"
import type { ThreadLog } from "./log"
import type { PromptQueue } from "./prompts"
import { type Surfaces, viewKey } from "./surfaces"
import { DEFAULT_LAYOUT, threadViews } from "./views"

export type AgentEvent =
  | { readonly event: "start"; readonly id: string; readonly parent?: string; readonly title: string; readonly task: string; readonly view?: string }
  | { readonly event: "status"; readonly id: string; readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }
  | { readonly event: "step"; readonly id: string; readonly text: string }
  | { readonly event: "end"; readonly id: string; readonly ok: boolean; readonly message?: string }
  /** Data for a section of the agent's view (checked by the core against the declared layout). */
  | { readonly event: "set"; readonly id: string; readonly view?: string; readonly section: string; readonly data: unknown }
  | { readonly event: "append"; readonly id: string; readonly view?: string; readonly section: string; readonly lines: unknown }
  /** Show declared surfaces for its agents; `gesture` is the host's word that the developer's call is running. */
  | { readonly event: "open"; readonly surfaces: ReadonlyArray<{ readonly surface: string; readonly agent: string; readonly focus?: boolean }>; readonly gesture?: boolean }
  | { readonly event: "close"; readonly surface: string; readonly id: string }
  /** Ask for the developer's attention (a reason) or stop asking (no reason). */
  | { readonly event: "attention"; readonly id: string; readonly reason?: string }

const ID = /^[A-Za-z0-9._-]{1,64}$/

/**
 * A plugin's agents in a thread's agents pane: their own stream, ids `<plugin>:<id>`, `step` lines as history,
 * and their views (the plugin's declared layouts, found by `layoutOf`).
 */
export const pluginAgents = (
  log: ThreadLog,
  threadId: string,
  layoutOf: (plugin: string, view: string) => Layout | undefined = () => undefined,
  surfaceOf: (plugin: string, name: string) => Surface | undefined = () => undefined,
  surfaces?: Surfaces,
  prompts?: PromptQueue,
) => {
  const streams = new Map<string, ReturnType<typeof makeActivity>>()
  const views = threadViews(log, threadId)
  const checkId = (id: unknown) => {
    if (typeof id !== "string" || !ID.test(id)) throw new Error(`agent id "${String(id)}" must be letters, digits, dot, dash or underscore`)
  }
  /** The store key of one of the plugin's views for an agent, started with its layout when it is new. */
  const keyFor = (plugin: string, id: string, view: string | undefined) => {
    const key = viewKey(views, id, view)
    if (!views.has(key) && view !== undefined) {
      const layout = layoutOf(plugin, view)
      if (layout === undefined) throw new Error(`plugin ${plugin} declares no view ${view}`)
      views.start(key, layout)
    }
    return key
  }
  const open = (plugin: string, e: Extract<AgentEvent, { event: "open" }>) => {
    if (surfaces === undefined || prompts === undefined) throw new Error("this thread shows no surfaces")
    for (const o of Array.isArray(e.surfaces) ? e.surfaces : []) {
      checkId(o.agent)
      const s = surfaceOf(plugin, String(o.surface))
      if (s === undefined) throw new Error(`plugin ${plugin} declares no surface ${String(o.surface)}`)
      // Panels open any time; the rest take the screen or the keys, so only the developer's call opens them.
      if (s.kind !== "panel" && e.gesture !== true) throw new Error(`${s.name} is a ${s.kind}: it opens only while you handle the developer's call; ask for attention instead`)
      const id = `${plugin}:${o.agent}`
      const key = keyFor(plugin, id, s.view)
      if (s.kind === "panel") surfaces.openPanel({ id: `${plugin}:${s.name}:${id}`, plugin, agent: id, view: key, name: s.name, scope: s.scope, edge: s.edge, size: s.size, input: s.input })
      else if (s.kind === "popover") {
        if (prompts.shownFor(id, key) === undefined) Effect.runSync(prompts.show({ plugin, agent: id, view: key, title: `${plugin} ${s.name}` }))
      } else surfaces.navigate(s.kind, key)
    }
  }
  return (plugin: string, e: AgentEvent) => {
    if (e.event === "open") return open(plugin, e)
    checkId(e.id)
    if ("parent" in e && e.parent !== undefined) checkId(e.parent)
    let a = streams.get(plugin)
    if (a === undefined) streams.set(plugin, (a = makeActivity(log, threadId, `${threadId}-${plugin}-agents`)))
    const id = `${plugin}:${e.id}`
    if (e.event === "set") return views.set(keyFor(plugin, id, e.view), e.section, e.data)
    if (e.event === "attention") return a.attention(id, typeof e.reason === "string" && e.reason.length > 0 ? e.reason.slice(0, 80) : undefined)
    if (e.event === "append") return views.append(keyFor(plugin, id, e.view), e.section, e.lines)
    if (e.event === "close") {
      const s = surfaceOf(plugin, String(e.surface))
      if (s?.kind === "panel") surfaces?.closePanel(`${plugin}:${s.name}:${id}`)
      if (s?.kind === "popover" && prompts !== undefined) {
        const shown = prompts.shownFor(id, viewKey(views, id, s.view))
        if (shown !== undefined) Effect.runSync(prompts.close(shown))
      }
      return
    }
    // An agent that ends takes its panels and popovers with it.
    if (e.event === "end") {
      surfaces?.closeAgent(id)
      if (prompts !== undefined) Effect.runSync(prompts.closeAgent(id))
    }
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
