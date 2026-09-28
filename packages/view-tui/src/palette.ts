import type { SessionState } from "@zarg/client"
import { displayName } from "./rail"
import { liveRlms, type Main } from "./view"

export interface PaletteEntry {
  readonly id: string
  readonly glyph: string
  readonly label: string
  readonly detail: string
  readonly go: { readonly main: Main; readonly viewing?: string } | { readonly command: string }
}

/** What ^k finds: agents (live, rail order), then the grid, review and zarg, then slash commands; the query keeps those whose label holds it. */
export const paletteEntries = (s: SessionState, query: string, commands: ReadonlyArray<{ readonly cmd: string; readonly desc: string }>): ReadonlyArray<PaletteEntry> => {
  const agents = Object.values(liveRlms(s))
    .filter((n) => n.id !== "zarg")
    .map((n): PaletteEntry => ({
      id: n.id,
      glyph: n.attention !== undefined ? "◆" : n.status === "running" ? "⠼" : n.status === "failed" ? "✗" : "✓",
      label: displayName(n),
      detail: n.attention?.reason ?? n.row?.text ?? n.status,
      go: { main: "agent", viewing: n.id },
    }))
  const places: ReadonlyArray<PaletteEntry> = [
    { id: "grid", glyph: "▦", label: "grid", detail: "all agents", go: { main: "grid" } },
    { id: "review", glyph: "●", label: "review", detail: "every agent's findings", go: { main: "review" } },
    { id: "zarg", glyph: "›", label: "zarg", detail: "the conversation", go: { main: "zarg" } },
  ]
  const cmds = commands.map((c): PaletteEntry => ({ id: c.cmd, glyph: "/", label: c.cmd, detail: c.desc, go: { command: c.cmd } }))
  const q = query.trim().toLowerCase()
  return [...agents, ...places, ...cmds].filter((e) => q.length === 0 || e.label.toLowerCase().includes(q))
}
