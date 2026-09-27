// packages/view/src/surfaces.ts
import { Schema } from "effect"
import { type Layout, Surface } from "./schema"

/** Why a plugin's surfaces are refused: not a surface, a view it does not declare, a name twice, a size out of range. */
export const surfacesProblem = (surfaces: unknown, views: ReadonlyArray<string>): string | undefined => {
  if (surfaces === undefined) return undefined
  if (!Array.isArray(surfaces)) return "surfaces must be a list"
  const names = new Set<string>()
  for (const raw of surfaces) {
    const r = Schema.decodeUnknownExit(Surface)(raw)
    if (r._tag !== "Success") return `surface ${String((raw as { name?: unknown } | null)?.name)} does not fit any kind (tile, panel, popover, sheet)`
    const s = r.value
    if (!/^[a-z][a-z0-9-]*$/.test(s.name)) return `surface name "${s.name}" must be kebab-case`
    if (names.has(s.name)) return `surface ${s.name} is declared twice`
    names.add(s.name)
    if (!views.includes(s.view)) return `surface ${s.name} shows view ${s.view}, which the plugin does not declare`
    if (s.kind === "panel" && (!Number.isInteger(s.size) || s.size < 1 || s.size > 40)) return `panel ${s.name}: size must be a whole number from 1 to 40`
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
