import { Schema } from "effect"
import { DATA, type Layout, type LayoutLeaf, type LayoutSection, type LeafKind, type LogLine, LogData } from "./schema"

type ActionSpec = { readonly id: string; readonly label: string; readonly key?: string; readonly on: "selection" | "row" | "none" }
type ColumnSpec = { readonly id: string; readonly label: string }
type Role = "summary" | "primary" | "log" | "pinned" | "aside"
export type LeafSpec =
  | { readonly kind: "stats" | "list" | "log" | "keyvalue" | "text" | "conversation"; readonly title?: string }
  | { readonly kind: "table"; readonly title?: string; readonly columns: ReadonlyArray<ColumnSpec>; readonly selectable?: boolean; readonly actions?: ReadonlyArray<ActionSpec> }
export type SectionSpec = (LeafSpec & { readonly role: Role }) | { readonly kind: "tabs"; readonly role: Role; readonly title?: string; readonly tabs: Readonly<Record<string, LeafSpec>> }
export type ViewSpec = Readonly<Record<string, SectionSpec>>
export interface ViewDef<S extends ViewSpec> {
  readonly name: string
  readonly sections: S
}

/** Every leaf's path: a section's id, or `<tabs id>.<tab id>`. */
export type SectionPath<S extends ViewSpec> = {
  [K in keyof S & string]: S[K] extends { readonly kind: "tabs"; readonly tabs: infer T } ? `${K}.${keyof T & string}` : K
}[keyof S & string]
type LeafAt<S extends ViewSpec, P extends string> = P extends `${infer K}.${infer T}`
  ? S[K] extends { readonly kind: "tabs"; readonly tabs: infer Tb } ? (T extends keyof Tb ? Tb[T] : never) : never
  : S[P]
/** The data a leaf at `P` takes. */
export type DataAt<S extends ViewSpec, P extends string> = LeafAt<S, P> extends { readonly kind: infer K } ? (K extends LeafKind ? (typeof DATA)[K]["Type"] : never) : never
/** Paths of the view's logs (the only sections `append` reaches). */
export type LogPath<S extends ViewSpec> = { [P in SectionPath<S>]: LeafAt<S, P> extends { readonly kind: "log" } ? P : never }[SectionPath<S>]

const NAME = /^[a-z][a-z0-9-]*$/
const ID = /^[a-z][a-zA-Z0-9-]*$/

const checkLeaf = (view: string, path: string, leaf: LeafSpec) => {
  const ids = leaf.kind === "table" ? (leaf.actions ?? []).map((a) => a.id) : []
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup !== undefined) throw new Error(`view ${view}: action ${dup} appears twice in ${path}`)
}

/** Declare a view: its sections in order, each with a kind and a role. Checked here, so a plugin's build refuses a bad one. */
export const defineView = <const S extends ViewSpec>(name: string, sections: S): ViewDef<S> => {
  if (!NAME.test(name)) throw new Error(`view name "${name}" must be kebab-case`)
  for (const [id, s] of Object.entries(sections)) {
    if (!ID.test(id)) throw new Error(`view ${name}: section id "${id}" must be letters, digits or dashes, starting with a letter`)
    if (s.kind === "tabs") {
      const tabs = Object.entries(s.tabs)
      if (tabs.length === 0) throw new Error(`view ${name}: tabs section ${id} has no tabs`)
      for (const [tid, t] of tabs) {
        if (!ID.test(tid)) throw new Error(`view ${name}: tab id "${tid}" in ${id} must be letters, digits or dashes`)
        checkLeaf(name, `${id}.${tid}`, t)
      }
    } else checkLeaf(name, id, s)
  }
  return { name, sections }
}

const leafOf = (id: string, l: LeafSpec): LayoutLeaf => ({
  id,
  kind: l.kind,
  ...(l.title !== undefined ? { title: l.title } : {}),
  ...(l.kind === "table" ? { columns: l.columns, ...(l.selectable !== undefined ? { selectable: l.selectable } : {}), ...(l.actions !== undefined ? { actions: l.actions } : {}) } : {}),
})

/** The view as data: what the manifest carries and the core sends. */
export const layoutOf = (def: ViewDef<ViewSpec>): Layout => ({
  name: def.name,
  sections: Object.entries(def.sections).map(([id, s]): LayoutSection =>
    s.kind === "tabs"
      ? { id, kind: "tabs", role: s.role, ...(s.title !== undefined ? { title: s.title } : {}), tabs: Object.entries(s.tabs).map(([tid, t]) => leafOf(tid, t)) }
      : { ...leafOf(id, s), role: s.role },
  ),
})

/** The leaf at `path` (`id` or `tabs.tab`), or undefined. */
export const leafAt = (layout: Layout, path: string): LayoutLeaf | undefined => {
  const [id, tab] = path.split(".")
  const s = layout.sections.find((x) => x.id === id)
  if (s === undefined) return undefined
  if (s.kind === "tabs") return tab === undefined ? undefined : s.tabs.find((t) => t.id === tab)
  return tab === undefined ? s : undefined
}

/** A push of `data` to `path`, checked against the section's kind (a plugin is untrusted). */
export const checkSet = (layout: Layout, path: string, data: unknown): { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string } => {
  const leaf = leafAt(layout, path)
  if (leaf === undefined) return { ok: false, error: `view ${layout.name} has no section ${path}` }
  const r = Schema.decodeUnknownExit(DATA[leaf.kind] as Schema.Codec<unknown, unknown>)(data)
  return r._tag === "Success" ? { ok: true, data: r.value } : { ok: false, error: `view ${layout.name}: ${path} is a ${leaf.kind} section; its data does not fit` }
}

/** Lines appended to a log, checked. */
export const checkAppend = (layout: Layout, path: string, lines: unknown): { readonly ok: true; readonly lines: ReadonlyArray<LogLine> } | { readonly ok: false; readonly error: string } => {
  const leaf = leafAt(layout, path)
  if (leaf === undefined) return { ok: false, error: `view ${layout.name} has no section ${path}` }
  if (leaf.kind !== "log") return { ok: false, error: `view ${layout.name}: ${path} is not a log` }
  const r = Schema.decodeUnknownExit(LogData)({ lines })
  return r._tag === "Success" ? { ok: true, lines: r.value.lines } : { ok: false, error: `view ${layout.name}: lines for ${path} do not fit` }
}
