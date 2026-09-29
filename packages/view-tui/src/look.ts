/** The look's small parts, testable without a frame. */
export const fit = (text: string, width: number) => {
  const one = text.replace(/\s*\n\s*/g, " ")
  if (width <= 0) return ""
  return one.length > width ? `${one.slice(0, width - 1)}…` : one
}
export const heading = (title: string, width: number) => {
  const t = fit(title, width)
  const room = width - t.length
  return { title: t, rule: room > 1 ? ` ${"─".repeat(room - 1)}` : "" }
}
export const gauge = (done: number, total: number, width: number) => {
  // No room (a folded rail, a narrow card): an empty gauge, never a negative repeat.
  const w = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0))
  const d = total > 0 ? Math.max(0, Math.min(w, Math.round((done / total) * w))) : 0
  return { done: "━".repeat(d), rest: "━".repeat(w - d) }
}
const GLYPH: Readonly<Record<string, string>> = { Enter: "⏎", Esc: "esc", Tab: "⇥", Space: "␣" }
export const keyGlyphs = (keys: string) => GLYPH[keys] ?? keys
