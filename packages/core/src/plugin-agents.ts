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
  /** Show declared surfaces for its agents; `gesture` is the host's word that the operator's call is running. */
  | { readonly event: "open"; readonly surfaces: ReadonlyArray<{ readonly surface: string; readonly agent: string; readonly focus?: boolean }>; readonly gesture?: boolean }
  | { readonly event: "close"; readonly surface: string; readonly id: string }
  /** Ask for the operator's attention (a reason) or stop asking (no reason). */
  | { readonly event: "attention"; readonly id: string; readonly reason?: string }

const ID = /^[A-Za-z0-9._-]{1,64}$/

/** JSON with every object's keys sorted: two layouts compare equal whatever order their keys were written in. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

/**
 * A plugin's agents in a thread's agents pane: their own stream, ids `<plugin>:<id>`, `step` lines as history,
 * and their views (the plugin's declared layouts, found by `layoutOf`).
 */
type Many = (refs: ReadonlyArray<string>) => Effect.Effect<{ readonly entities: ReadonlyArray<{ readonly ref: string; readonly type: string; readonly id: string; readonly label: { readonly text: string; readonly tone: string; readonly glyph: string } }> }>

/** A table section's ref columns get their labels (resolved by the host) before the data reaches clients. */
export const withLabels = (layout: Layout, section: string, data: unknown, many: Many) =>
  Effect.gen(function* () {
    const leaves = layout.sections.flatMap((s) => (s.kind === "tabs" ? (s.tabs ?? []).map((t) => ({ ...t, id: `${s.id}.${t.id}` })) : [s]))
    const leaf = leaves.find((s) => s.id === section) as { readonly columns?: ReadonlyArray<{ readonly id: string; readonly ref?: true }> } | undefined
    const cols = (leaf?.columns ?? []).filter((c) => c.ref === true).map((c) => c.id)
    const rows = (data as { readonly rows?: ReadonlyArray<{ readonly cells: Readonly<Record<string, string>> }> } | undefined)?.rows
    if (cols.length === 0 || rows === undefined) return data
    const refs = [...new Set(rows.flatMap((r) => cols.map((c) => r.cells[c] ?? "")).filter((s) => s.includes(":")))]
    if (refs.length === 0) return data
    const { entities } = yield* many(refs)
    // Keyed by the ref as the plugin wrote it (with or without its version).
    const labels = Object.fromEntries(refs.flatMap((ref) => {
      const e = entities.find((x) => ref === x.ref || ref === `${x.type}:${x.id}`)
      return e === undefined ? [] : [[ref, e.label]]
    }))
    return { ...(data as object), labels }
  })

export const pluginAgents = (
  log: ThreadLog,
  threadId: string,
  layoutOf: (plugin: string, view: string) => Layout | undefined = () => undefined,
  surfaceOf: (plugin: string, name: string) => Surface | undefined = () => undefined,
  surfaces?: Surfaces,
  prompts?: PromptQueue,
  /** The plugin's declared surfaces (its cards among them). */
  surfacesOf: (plugin: string) => ReadonlyArray<Surface> = () => [],
  /** Resolves refs to labels (the host's entities) for tables' ref columns. */
  many?: Many,
) => {
  // Per view: labels resolve in order, so a later set never lands before an earlier one.
  const pending = new Map<string, Promise<unknown>>()
  const streams = new Map<string, ReturnType<typeof makeActivity>>()
  const views = threadViews(log, threadId)
  const checkId = (id: unknown) => {
    if (typeof id !== "string" || !ID.test(id)) throw new Error(`agent id "${String(id)}" must be letters, digits, dot, dash or underscore`)
  }
  /** The store key of one of the plugin's views for an agent, started with its layout when it is new. */
  const keyFor = (plugin: string, id: string, view: string | undefined) => {
    const key = viewKey(views, id, view)
    if (view === undefined) return key
    const layout = layoutOf(plugin, view)
    if (!views.has(key)) {
      if (layout === undefined) throw new Error(`plugin ${plugin} declares no view ${view}`)
      views.start(key, layout)
      return key
    }
    // A view kept from an earlier core (the thread log replays it) whose plugin now declares another layout: start
    // it again with the one declared now (its grid card, if any, kept), so new sections and links take effect.
    const { card, ...kept } = views.layout(key) ?? { sections: [] as ReadonlyArray<never> }
    if (layout !== undefined && canonical(kept) !== canonical(layout)) views.start(key, card !== undefined ? { ...layout, card } : layout)
    return key
  }
  const open = (plugin: string, e: Extract<AgentEvent, { event: "open" }>) => {
    if (surfaces === undefined || prompts === undefined) throw new Error("this thread shows no surfaces")
    // Every surface is checked before any shows: an open of several is one change, or none.
    const checked = (Array.isArray(e.surfaces) ? e.surfaces : []).map((o) => {
      checkId(o.agent)
      const s = surfaceOf(plugin, String(o.surface))
      if (s === undefined) throw new Error(`plugin ${plugin} declares no surface ${String(o.surface)}`)
      // A card is how the agent shows in the grid: there is nothing to open.
      if (s.kind === "card") throw new Error(`${s.name} is a card: it shows in the grid by itself`)
      // A nav item is the operator's to open, from above the agents.
      if (s.kind === "nav") throw new Error(`${s.name} is a nav item: the operator opens it`)
      // Panels open any time; the rest take the screen or the keys, so only the operator's call opens them.
      if (s.kind !== "panel" && e.gesture !== true) throw new Error(`${s.name} is a ${s.kind}: it opens only while you handle the developer's call; ask for attention instead`)
      const id = `${plugin}:${o.agent}`
      // Only for its own agents that exist: no surfaces for ids it made up.
      if (!views.has(id)) throw new Error(`plugin ${plugin} has not started an agent ${o.agent}`)
      if (s.kind === "popover" && prompts.shownFor(id, viewKey(views, id, s.view)) === undefined && prompts.shownBy(plugin)) throw new Error(`plugin ${plugin} already has a popover up: one at a time`)
      return { s, id }
    })
    if (checked.filter((c) => c.s.kind === "popover").length > 1) throw new Error(`plugin ${plugin} already has a popover up: one at a time`)
    for (const { s, id } of checked) {
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
    if (e.event === "set") {
      const key = keyFor(plugin, id, e.view)
      const layout = e.view === undefined ? undefined : layoutOf(plugin, e.view)
      if (many === undefined || layout === undefined) return views.set(key, e.section, e.data)
      const next = (pending.get(key) ?? Promise.resolve())
        .then(() => Effect.runPromise(withLabels(layout, e.section, e.data, many).pipe(Effect.orElseSucceed(() => e.data))))
        .then((d) => views.set(key, e.section, d))
      pending.set(key, next)
      return
    }
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
      // An agent whose view the plugin has a card for carries the card: the grid draws it from the view.
      const card = surfacesOf(plugin).find((x) => x.kind === "card" && x.view === e.view)
      views.start(id, card?.kind === "card" ? { ...layout, card: { headline: card.headline, ...(card.recent !== undefined ? { recent: card.recent } : {}), ...(card.action !== undefined ? { action: card.action } : {}) } } : layout)
      // Its other views start afresh too: a new run's panel never shows the last run's numbers.
      for (const key of views.keys().filter((k) => k.startsWith(`${id}@`))) views.start(key, views.layout(key)!)
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
