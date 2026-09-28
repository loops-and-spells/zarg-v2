/** References to any plugin's data: `<plugin>/<kind>:<id>[@<version>]`. No dependencies beyond Schema: runs in the sandbox. */
import { Schema } from "effect"

export interface Ref { readonly type: string; readonly id: string; readonly version?: string }
const TYPE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/

export const refProblem = (s: string): string | undefined => {
  const colon = s.indexOf(":")
  if (colon < 0) return `"${s}" has no type: a ref is <plugin>/<kind>:<id>`
  const type = s.slice(0, colon)
  if (!TYPE.test(type)) return `"${type}" is not a type: a type is plugin/kind, like gherkin/card`
  const rest = s.slice(colon + 1)
  if (rest.includes(":")) return `"${s}" has more than one ":"`
  const [id, version, extra] = rest.split("@")
  if (id === undefined || id.length === 0) return `"${s}" has no id`
  if (extra !== undefined) return `"${s}" has more than one "@"`
  if (version !== undefined && !/^[0-9a-f]+$/.test(version)) return `"${s}" has an empty or non-hex version`
  return undefined
}
export const parseRef = (s: string): Ref | undefined => {
  if (refProblem(s) !== undefined) return undefined
  const colon = s.indexOf(":")
  const [id, version] = s.slice(colon + 1).split("@")
  return { type: s.slice(0, colon), id: id!, ...(version !== undefined ? { version } : {}) }
}
export const formatRef = (r: Ref): string => `${r.type}:${r.id}${r.version !== undefined ? `@${r.version}` : ""}`

/** JSON with keys sorted at every depth: equal data, equal text. */
export const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x))

/** cyrb53: stable, not secure (plugin bundles cannot import node:crypto). */
const cyrb53 = (s: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0")
}
/** An entity's version: 12 hex over its canonical data. */
export const versionOf = (v: unknown): string => cyrb53(canonical(v)).slice(-12)

export const Label = Schema.Struct({ text: Schema.String, tone: Schema.String, glyph: Schema.String })
export type Label = typeof Label.Type
export const EntityShape = Schema.Struct({ ref: Schema.String, type: Schema.String, id: Schema.String, version: Schema.String, label: Label, data: Schema.Unknown })
export type Entity = typeof EntityShape.Type
export const Query = Schema.Struct({
  type: Schema.String,
  where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  text: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
})
export type Query = typeof Query.Type
export const ENTITY_FAILURES = ["NotFound", "UnknownType", "NotAllowed", "ProviderFailed", "OutOfScope"] as const
