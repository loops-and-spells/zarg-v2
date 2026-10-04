import type { Frame } from "@zarg/evidence-capture-xterm"
import { esc, frameSvg } from "./frame"

/** A medium as the host hands it to renderEvidence. */
export type RenderInput = {
  readonly kind: string
  readonly caption: string
  readonly meta?: unknown
  readonly files: ReadonlyArray<{ readonly name: string; readonly url: string; readonly text?: string }>
}

/** A terminal medium as catalog HTML (pages sit one level below the site root, hence "../"). */
export const render = (input: RenderInput): { readonly html: string; readonly assets: ReadonlyArray<string> } => {
  const main = input.files[0]
  const text = main?.text ?? ""
  switch (input.kind.split("/")[1]) {
    case "frame":
      return { html: frameSvg(JSON.parse(text) as Frame), assets: ["terminal.css"] }
    case "cast":
      return { html: `<div class="evidence-cast" data-cast-data="${esc(text)}"></div>`, assets: ["asciinema-player.css", "asciinema-player.min.js", "cast.js"] }
    case "gif":
      return { html: `<img class="evidence-gif" src="../${esc(main?.url ?? "")}" alt="${esc(input.caption)}">`, assets: [] }
    default: {
      const fold = (input.meta as { fold?: unknown } | undefined)?.fold === true
      return {
        html: fold ? `<details class="evidence-text"><summary>${esc(input.caption)}</summary><pre>${esc(text)}</pre></details>` : `<pre class="evidence-text">${esc(text)}</pre>`,
        assets: ["terminal.css"],
      }
    }
  }
}
