// packages/view/src/surfaces.ts
import { Schema } from "effect"
import { leafAt } from "./layout"
import { type Layout, Surface } from "./schema"

/** Why a plugin's surfaces are refused: not a surface, a view it does not declare, a name twice, a size out of range. */
export const surfacesProblem = (surfaces: unknown, layouts: ReadonlyArray<Layout>): string | undefined => {
  if (surfaces === undefined) return undefined
  if (!Array.isArray(surfaces)) return "surfaces must be a list"
  const names = new Set<string>()
  for (const raw of surfaces) {
    const r = Schema.decodeUnknownExit(Surface)(raw)
    if (r._tag !== "Success") return `surface ${String((raw as { name?: unknown } | null)?.name)} does not fit any kind (tile, panel, popover, sheet, card, nav)`
    const s = r.value
    if (!/^[a-z][a-z0-9-]*$/.test(s.name)) return `surface name "${s.name}" must be kebab-case`
    if (names.has(s.name)) return `surface ${s.name} is declared twice`
    names.add(s.name)
    const layout = layouts.find((l) => l.name === s.view)
    if (layout === undefined) return `surface ${s.name} shows view ${s.view}, which the plugin does not declare`
    if (s.kind === "panel" && (!Number.isInteger(s.size) || s.size < 1 || s.size > 40)) return `panel ${s.name}: size must be a whole number from 1 to 40`
    if (s.kind === "card") {
      const problem = cardProblem(s, layout)
      if (problem !== undefined) return problem
    }
  }
  return undefined
}

/** Why an action's `opens` is refused: it names a surface the plugin does not declare. */
export const opensProblem = (views: ReadonlyArray<Layout>, surfaces: ReadonlyArray<{ readonly name: string }>): string | undefined => {
  const names = new Set(surfaces.map((s) => s.name))
  for (const v of views) {
    const leaves = v.sections.flatMap((s) => (s.kind === "tabs" ? s.tabs : [s]))
    for (const a of [...leaves.flatMap((l) => l.actions ?? []), ...(v.actions ?? [])])
      for (const o of a.opens ?? []) if (!names.has(o.surface)) return `view ${v.name}: action ${a.id} opens ${o.surface}, which the plugin does not declare`
  }
  return undefined
}

/** A card's slots must be sections of its view of the right kind, and its action one of the view's. */
const cardProblem = (c: { readonly name: string; readonly headline: string; readonly recent?: string; readonly action?: string }, layout: Layout): string | undefined => {
  const head = leafAt(layout, c.headline)
  if (head === undefined) return `card ${c.name}: headline ${c.headline} is not a section of view ${layout.name}`
  if (head.kind !== "stats") return `card ${c.name}: headline ${c.headline} is a ${head.kind}, not stats`
  if (c.recent !== undefined) {
    const recent = leafAt(layout, c.recent)
    if (recent === undefined) return `card ${c.name}: recent ${c.recent} is not a section of view ${layout.name}`
    if (!["log", "list", "table"].includes(recent.kind)) return `card ${c.name}: recent ${c.recent} is a ${recent.kind}, not a log, list or table`
  }
  if (c.action !== undefined) {
    const leaves = layout.sections.flatMap((x) => (x.kind === "tabs" ? x.tabs : [x]))
    const ids = [...leaves.flatMap((l) => l.actions ?? []), ...(layout.actions ?? [])].map((a) => a.id)
    if (!ids.includes(c.action)) return `card ${c.name}: action ${c.action} is not an action of view ${layout.name}`
  }
  return undefined
}
