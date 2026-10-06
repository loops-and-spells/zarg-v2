import type { SessionState } from "@zarg/client"
import { displayName } from "./rail"
import { liveRlms, type Main, NAV } from "./view"

export interface PaletteEntry {
  readonly id: string
  readonly glyph: string
  readonly label: string
  readonly detail: string
  readonly go: { readonly main: Main; readonly viewing?: string } | { readonly command: string } | { readonly nav: string }
}

/** What ^k finds: agents (live, rail order), then the inbox, the plugins' views, the grid, review and zarg, then slash commands; the query keeps those whose label holds it. */
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
    { id: "inbox", glyph: "▤", label: "inbox", detail: "what needs you", go: { main: "inbox" } },
    ...(s.thread.nav ?? []).map((n): PaletteEntry => ({ id: `${NAV}${n.id}`, glyph: "▤", label: n.label, detail: "view", go: { nav: `${NAV}${n.id}` } })),
    { id: "grid", glyph: "▦", label: "agents", detail: "all agents, as cards", go: { main: "grid" } },
    { id: "review", glyph: "●", label: "review", detail: "every agent's findings", go: { main: "review" } },
    { id: "zarg", glyph: "›", label: "zarg", detail: "the conversation", go: { main: "zarg" } },
  ]
  const cmds = commands.map((c): PaletteEntry => ({ id: c.cmd, glyph: "/", label: c.cmd, detail: c.desc, go: { command: c.cmd } }))
  const q = query.trim().toLowerCase()
  return [...agents, ...places, ...cmds].filter((e) => q.length === 0 || e.label.toLowerCase().includes(q))
}
