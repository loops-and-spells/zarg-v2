import type { Layout } from "./schema"

/** Keys the terminal shell keeps for itself: an agent may not map them (Ctrl and Alt chords too). */
export const RESERVED_TERMINAL: ReadonlySet<string> = new Set(["up", "down", "left", "right", "tab", "shift+tab", "return", "enter", "escape", "space", "pageup", "pagedown", "[", "]", "g", "x", "/"])

/** Whether a platform keeps this key for itself. A platform zarg does not know reserves nothing here. */
export const reservedFor = (platform: string, key: string) => platform === "terminal" && (RESERVED_TERMINAL.has(key) || /^(ctrl|alt|meta|option)\+/.test(key))

/** An action's key on a platform: its mapping for that platform, or `key` for the terminal. */
export const keyFor = (a: { readonly key?: string; readonly keys?: Readonly<Record<string, string>> }, platform: string): string | undefined =>
  a.keys?.[platform] ?? (platform === "terminal" ? a.key : undefined)

type Mapped = { readonly id: string; readonly key?: string; readonly keys?: Readonly<Record<string, string>> }
const mappings = (a: Mapped) => Object.entries({ ...(a.keys ?? {}), ...(a.key !== undefined ? { terminal: a.key } : {}) })

/**
 * Why a view's action keys are refused, or undefined: a key its platform keeps, or one key twice where both would
 * answer it (in one table, or between a table and the view's own actions, which answer from any section).
 */
export const keysProblem = (layout: Layout): string | undefined => {
  const leaves = layout.sections.flatMap((s) => (s.kind === "tabs" ? s.tabs : [s]))
  const own = layout.actions ?? []
  for (const a of [...leaves.flatMap((l) => l.actions ?? []), ...own])
    for (const [platform, key] of mappings(a)) if (reservedFor(platform, key)) return `view ${layout.name}: action ${a.id} maps ${key}, a key ${platform} keeps for itself`
  for (const scope of [...leaves.map((l) => [...(l.actions ?? []), ...own]), own]) {
    const seen = new Set<string>()
    for (const a of scope)
      for (const [platform, key] of mappings(a)) {
        if (seen.has(`${platform}:${key}`)) return `view ${layout.name}: ${key} is mapped twice on ${platform}`
        seen.add(`${platform}:${key}`)
      }
  }
  return undefined
}
