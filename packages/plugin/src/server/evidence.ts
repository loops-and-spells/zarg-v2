import { Duration, Effect } from "effect"
import { resolveKind } from "@zarg/evidence-capture"
import type { Manifest } from "./loaded"

export type RenderInput = {
  readonly kind: string
  readonly caption: string
  readonly meta?: unknown
  readonly files: ReadonlyArray<{ readonly name: string; readonly url: string; readonly text?: string }>
}
export type Rendered =
  | { readonly ok: true; readonly owner: string; readonly html: string; readonly assets: ReadonlyArray<{ readonly name: string; readonly path: string }> }
  | { readonly ok: false; readonly reason: string }
export type EvidenceKinds = Readonly<Record<string, { readonly owner: string; readonly label: string; readonly files: "text" | "binary" }>>

const RENDER_MS = 10_000

/** Evidence kinds by ref, and rendering through the plugin that owns each: a reason in place of any failure. */
export const makeEvidence = (deps: {
  readonly manifests: () => ReadonlyArray<Manifest>
  readonly waiting: () => ReadonlyArray<string>
  readonly assetsOf: (plugin: string) => Readonly<Record<string, string>>
  readonly invoke: (plugin: string, params: RenderInput) => Effect.Effect<unknown, { readonly message: string }>
  /** How long one render may take (default 10 s). */
  readonly timeoutMs?: number
}) => {
  // A plugin that once did not answer in time is not asked again: one hung renderer costs one timeout, not one per medium.
  const hung = new Set<string>()
  const kinds = (): EvidenceKinds =>
    Object.fromEntries(
      deps
        .manifests()
        .filter((m) => m.scopes.evidence === true)
        .flatMap((m) => Object.entries(m.evidence ?? {}).map(([k, d]) => [`${m.name}/${k}`, { owner: m.name, label: d.label, files: d.files }] as const))
        .sort(([a], [b]) => a.localeCompare(b)),
    )
  // Suspended: whether its plugin hung is asked when it runs, not when it is built.
  const render = (input: RenderInput): Effect.Effect<Rendered> => Effect.suspend(() => renderNow(input))
  const renderNow = (input: RenderInput): Effect.Effect<Rendered> => {
    const kind = resolveKind(input.kind)
    const owner = kind.split("/")[0]!
    const decl = kinds()[kind]
    if (decl === undefined)
      return Effect.succeed({ ok: false, reason: `rendered by ${owner}, ${deps.waiting().includes(owner) ? "not granted" : deps.manifests().some((m) => m.name === owner) ? `which has no kind ${kind}` : "not installed"}` })
    const could = (why: string): Rendered => ({ ok: false, reason: `${owner} could not render ${kind}: ${why}` })
    if (hung.has(owner)) return Effect.succeed({ ok: false, reason: `${owner} did not answer in time earlier; its media are not rendered` })
    return deps.invoke(owner, { ...input, kind }).pipe(
      Effect.timeoutOption(Duration.millis(deps.timeoutMs ?? RENDER_MS)),
      Effect.map((answer): Rendered => {
        if (answer._tag === "None") {
          hung.add(owner)
          return could(`no answer within ${deps.timeoutMs ?? RENDER_MS} ms`)
        }
        const r = answer.value as { html?: unknown; assets?: unknown }
        if (typeof r?.html !== "string") return could("it returned no html")
        const named = Array.isArray(r.assets) ? r.assets.map(String) : []
        const declared = deps.assetsOf(owner)
        const stray = named.find((n) => declared[n] === undefined)
        if (stray !== undefined) return { ok: false, reason: `asset ${stray} is not one ${owner} declared` }
        return { ok: true, owner, html: r.html, assets: named.map((name) => ({ name, path: declared[name]! })) }
      }),
      Effect.catch((e: unknown) => Effect.succeed(could(String((e as { message?: unknown })?.message ?? e)))),
    )
  }
  return { kinds, render }
}
