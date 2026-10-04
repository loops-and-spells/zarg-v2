import type { Frame } from "@zarg/evidence-capture-xterm"

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
/** A column's width and a row's height, in SVG units (14px monospace). */
const CW = 8.4
const LH = 17
const n = (v: number) => String(Number(v.toFixed(1)))

/** A terminal frame as SVG: the screen's background, each span's background and text at its column. The same frame, the same bytes. */
export const frameSvg = (f: Frame): string => {
  const w = n(f.cols * CW)
  const h = n(f.rows * LH)
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" class="evidence-frame" viewBox="0 0 ${w} ${h}" font-family="ui-monospace, Menlo, monospace" font-size="14">`, `<rect x="0" y="0" width="${w}" height="${h}" fill="${f.bg}"/>`]
  f.lines.forEach((line, row) => {
    let col = 0
    for (const s of line) {
      if (s.bg !== undefined) parts.push(`<rect x="${n(col * CW)}" y="${n(row * LH)}" width="${n(s.cells * CW)}" height="${n(LH)}" fill="${s.bg}"/>`)
      col += s.cells
    }
  })
  f.lines.forEach((line, row) => {
    if (line.every((s) => s.t.trim() === "")) return
    let col = 0
    const spans = line.flatMap((s) => {
      const at = col
      col += s.cells
      if (s.t.trim() === "") return []
      const look = [`fill="${s.fg ?? f.fg}"`, ...(s.b ? ['font-weight="bold"'] : []), ...(s.i ? ['font-style="italic"'] : []), ...(s.u ? ['text-decoration="underline"'] : []), ...(s.d ? ['opacity="0.6"'] : [])]
      return [`<tspan x="${n(at * CW)}" ${look.join(" ")}>${esc(s.t)}</tspan>`]
    })
    parts.push(`<text y="${n((row + 0.8) * LH)}" xml:space="preserve">${spans.join("")}</text>`)
  })
  parts.push("</svg>")
  return parts.join("")
}
