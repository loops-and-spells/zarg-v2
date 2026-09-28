import { Effect, Schema } from "effect"
import { versionOf } from "@zarg/entities"
export { entitiesProblem } from "@zarg/view"
import type { PluginTone } from "@zarg/tokens"
import { PluginFailure } from "./services"

export type EntityOp = "get" | "query" | "label" | "context" | "version"
export interface EntityDecl {
  readonly doc: string
  readonly data: Schema.Codec<any, any>
  readonly tone: PluginTone
  readonly glyph: string
  /** Named writes: command → one of the plugin's methods (its own checks and gate apply). */
  readonly commands?: Readonly<Record<string, string>>
  /** The nav surface that shows this kind (a ref's label opens it). */
  readonly open?: string
  /** The ops this plugin serves itself (the manifest carries them; `make` cannot run at build). Default: get, label, version; graph plugins: none (the host serves graph kinds). */
  readonly ops?: ReadonlyArray<EntityOp>
}
export interface EntityHandlers<D = any> {
  readonly get?: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly data: D }>, PluginFailure>
  readonly query?: (q: { readonly where?: Readonly<Record<string, unknown>>; readonly text?: string; readonly limit?: number }) => Effect.Effect<ReadonlyArray<string>, PluginFailure>
  readonly label?: (e: { readonly id: string; readonly data: D }) => string
  readonly context?: (e: { readonly id: string; readonly data: D }) => Effect.Effect<string, PluginFailure>
  readonly version?: (e: { readonly id: string; readonly data: D }) => string
}

/** Which ops a plugin serves itself: those with a handler, plus `version` (defaulted) wherever it serves `get`. */
export const opsOf = (h: EntityHandlers | undefined): ReadonlyArray<EntityOp> =>
  (["get", "query", "label", "context", "version"] as const).filter((op) => h?.[op] !== undefined || (op === "version" && h?.get !== undefined))

const fail = (message: string) => new PluginFailure({ tag: "ProviderFailed", message })
/** The reserved `$entity` method over a plugin's handlers. */
export const serveEntity = (all: Readonly<Record<string, EntityHandlers>> | undefined) => (p: { readonly op: EntityOp; readonly kind: string; readonly ids?: ReadonlyArray<string>; readonly query?: Parameters<NonNullable<EntityHandlers["query"]>>[0] }) =>
  Effect.gen(function* () {
    const h = all?.[p.kind]
    if (h === undefined) return yield* Effect.fail(fail(`no entity kind ${p.kind}`))
    if (p.op === "query") return h.query === undefined ? yield* Effect.fail(fail(`${p.kind} has no query`)) : yield* h.query(p.query ?? {})
    if (h.get === undefined) return yield* Effect.fail(fail(`${p.kind} has no get`))
    const got = yield* h.get(p.ids ?? [])
    if (p.op === "get") return got
    if (p.op === "label") return got.map((e) => ({ id: e.id, text: h.label?.(e) ?? e.id }))
    if (p.op === "version") return got.map((e) => ({ id: e.id, version: h.version?.(e) ?? versionOf(e.data) }))
    return yield* Effect.forEach(got, (e) => Effect.map(h.context?.(e) ?? Effect.succeed(""), (text) => ({ id: e.id, text })))
  })
