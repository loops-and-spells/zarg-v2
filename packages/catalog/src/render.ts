import type { Catalog, MediaView } from "./model"
import { encodePath, type Fragment, type Rendered } from "./pages"
import { sanitize } from "./sanitize"

/** What a renderer answers for a medium (the host's evidence.render has this shape). */
export type RenderedLike =
  | { readonly ok: true; readonly owner: string; readonly html: string; readonly assets: ReadonlyArray<{ readonly name: string; readonly path: string }> }
  | { readonly ok: false; readonly reason: string }

/** Every committed medium through `render`, its HTML sanitized; anything not rendered becomes a fallback with its reason. */
export const renderAll = async (c: Catalog, render: (m: MediaView) => Promise<RenderedLike>): Promise<Rendered> => {
  const media = c.scenarios.flatMap((s) => s.proof?.media ?? []).filter((m) => m.present)
  const out = new Map<string, Fragment>()
  for (const m of media) {
    const r = await render({ ...m, files: m.files.map((f) => ({ ...f, url: encodePath(f.url) })) })
    out.set(m.path, r.ok ? { html: await sanitize(r.html), assets: r.assets.map((a) => ({ owner: r.owner, ...a })) } : { fallback: r.reason })
  }
  return out
}
