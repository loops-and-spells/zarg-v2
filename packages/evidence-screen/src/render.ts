/** A medium as the host hands it to renderEvidence. */
export type RenderInput = {
  readonly kind: string
  readonly caption: string
  readonly meta?: unknown
  readonly files: ReadonlyArray<{ readonly name: string; readonly url: string; readonly text?: string }>
}
type Step = {
  readonly action: string
  readonly screenshot?: string
  readonly console?: ReadonlyArray<{ readonly level: string; readonly text: string }>
  readonly requests?: ReadonlyArray<{ readonly method: string; readonly url: string; readonly status: number; readonly ms?: number }>
  readonly ms?: number
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
// Pages sit one level below the site root.
const src = (url: string) => `../${esc(url)}`

const timeline = (input: RenderInput) => {
  const steps = JSON.parse(input.files[0]?.text ?? "[]") as ReadonlyArray<Step>
  // A step's screenshot is the attached file whose name ends with it (the writer numbers files: 2-001.png).
  const urlOf = (shot: string | undefined) => (shot === undefined ? undefined : input.files.find((f) => f.name === shot || f.name.endsWith(`-${shot}`))?.url)
  const failed = (s: Step) => (s.console ?? []).some((c) => c.level === "error") || (s.requests ?? []).some((r) => r.status >= 400 || r.status === 0)
  const strip = steps.flatMap((s, i) => {
    const url = urlOf(s.screenshot)
    return url === undefined ? [] : [`<a class="thumb${failed(s) ? " failed" : ""}" data-step="${i}"><img src="${src(url)}" alt="${esc(s.action)}" loading="lazy"></a>`]
  })
  const items = steps.map((s, i) => {
    const url = urlOf(s.screenshot)
    const lines = (s.console ?? []).map((c) => `<li class="${c.level === "error" ? "error" : "log"}">${esc(c.text)}</li>`)
    const reqs = (s.requests ?? []).map((r) => `<li><code>${esc(`${r.method} ${r.url}`)}</code> <span class="status${r.status >= 400 || r.status === 0 ? " bad" : ""}">${r.status === 0 ? "failed" : r.status}</span>${r.ms === undefined ? "" : ` <small>${r.ms} ms</small>`}</li>`)
    return [
      `<li class="evidence-step${failed(s) ? " failed" : ""}" data-step="${i}">`,
      `<div class="action"><code>${esc(s.action)}</code>${s.ms === undefined ? "" : ` <small>${s.ms} ms</small>`}</div>`,
      url === undefined ? "" : `<img src="${src(url)}" alt="${esc(s.action)}" loading="lazy">`,
      lines.length === 0 ? "" : `<ul class="console">${lines.join("")}</ul>`,
      reqs.length === 0 ? "" : `<ul class="requests">${reqs.join("")}</ul>`,
      `</li>`,
    ].join("")
  })
  return `<div class="evidence-trace">${strip.length === 0 ? "" : `<div class="evidence-strip">${strip.join("")}</div>`}<ol class="evidence-steps">${items.join("")}</ol></div>`
}

/** A screen medium as catalog HTML. */
export const render = (input: RenderInput): { readonly html: string; readonly assets: ReadonlyArray<string> } => {
  const url = input.files[0]?.url ?? ""
  switch (input.kind.split("/")[1]) {
    case "video":
      return { html: `<video class="evidence-video" controls preload="metadata" src="${src(url)}"></video>`, assets: ["screen.css"] }
    case "trace":
      return { html: timeline(input), assets: ["screen.css", "trace.js"] }
    default:
      return { html: `<a class="evidence-shot" href="${src(url)}"><img src="${src(url)}" alt="${esc(input.caption)}" loading="lazy"></a>`, assets: ["screen.css"] }
  }
}
