// THROWAWAY MOCKUP (never commit): the rail with nav items above the agents, and the Journeys view's top.
// Live: `mise x -- bun packages/view-tui/mockups/journeys.tsx` — keys 1-4 switch the rail, a-c the view, q quits.
// Frames (every combination printed): add `--frames`.
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { type ReactNode, useState } from "react"

const T = { bg: "#0f1115", raised: "#161a21", line: "#262b35", text: "#d7dce2", dim: "#6b7280", faint: "#3b4150", accent: "#7aa2f7", attn: "#e0af68", ok: "#9ece6a", err: "#f7768e", sel: "#1f2533", shade: "#1a1f28" }
const W = 24

type Rail = 1 | 2 | 3 | 4
type Top = "a" | "b" | "c"

// ── The rail ─────────────────────────────────────────────────────────────
const NAV = [{ glyph: "▤", name: "Journeys", note: "5" }]
const AGENTS = [
  { glyph: "▾", tone: T.dim, name: "rehearse", note: "12/18", depth: 0 },
  { glyph: "◆", tone: T.attn, name: "tester-1", note: "3 found", depth: 1 },
  { glyph: "⠼", tone: T.accent, name: "tester-2", note: "8/18", depth: 1 },
  { glyph: "✓", tone: T.dim, name: "zarg", note: "done", depth: 0 },
]
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))
const Row = (p: { glyph: string; tone: string; name: string; note: string; depth?: number; on?: boolean; dim?: boolean }) => {
  const indent = "  ".repeat(p.depth ?? 0)
  const room = W - 2 - indent.length - 2 - p.note.length
  return (
    <text wrapMode="none" {...(p.on ? { bg: T.sel } : {})}>
      <span fg={T.accent}>{p.on ? "▍" : " "}</span>
      <span>{indent}</span>
      <span fg={p.tone}>{p.glyph}</span>
      <span fg={p.dim ? T.dim : T.text}>{p.on ? <b>{` ${pad(p.name, room - 1)}`}</b> : ` ${pad(p.name, room - 1)}`}</span>
      <span fg={T.dim}>{p.note}</span>
    </text>
  )
}
const Heading = (p: { title: string; extra?: string; rule?: boolean; focused?: boolean }) => (
  <text wrapMode="none">
    <span fg={p.focused ? T.accent : T.dim}><b>{` ${p.title}`}</b></span>
    {p.extra !== undefined ? <span fg={T.attn}>{`  ${p.extra}`}</span> : null}
    {p.rule ? <span fg={T.faint}>{` ${"─".repeat(W)}`}</span> : null}
  </text>
)
const Sep = () => <text fg={T.line} wrapMode="none">{` ${"─".repeat(W - 3)}`}</text>

const RailView = (p: { v: Rail }) => (
  <box style={{ width: W, flexShrink: 0, flexDirection: "column", backgroundColor: T.raised, paddingTop: 1 }}>
    {p.v === 3 ? <Heading title="Views" /> : null}
    {p.v === 4 ? (
      <box style={{ flexDirection: "column", backgroundColor: T.shade, paddingTop: 0 }}>
        {NAV.map((n) => <Row key={n.name} glyph={n.glyph} tone={T.accent} name={n.name} note={n.note} on />)}
      </box>
    ) : (
      NAV.map((n) => <Row key={n.name} glyph={n.glyph} tone={T.accent} name={n.name} note={n.note} on />)
    )}
    {p.v === 2 ? <text> </text> : <Sep />}
    {p.v === 2 ? <Heading title="Agents" extra="◆1" rule /> : <Heading title="Agents" extra="◆1" />}
    {AGENTS.map((a) => <Row key={a.name} {...a} dim={a.glyph === "✓"} />)}
    <text> </text>
    <Row glyph="▸" tone={T.dim} name="archived" note="2" dim />
  </box>
)

// ── Design language concepts (rails A, B, C) ─────────────────────────────
// One grammar for every row: a 1-col gutter (▍ when it is where you are), a glyph, a name, a right-aligned note.
const RW = 26
type Item = { glyph: string; tone: string; name: string; note?: string; noteTone?: string; depth?: number; last?: boolean; on?: boolean; dim?: boolean }
const VIEWS: ReadonlyArray<Item> = [
  { glyph: "▤", tone: T.accent, name: "Journeys", note: "5", on: true },
  { glyph: "◇", tone: T.dim, name: "Review", note: "3", noteTone: T.attn },
]
const TREE: ReadonlyArray<Item> = [
  { glyph: "◆", tone: T.attn, name: "zarg", note: "asks", noteTone: T.attn },
  { glyph: "⠼", tone: T.accent, name: "rehearse", note: "12/18" },
  { glyph: "◆", tone: T.attn, name: "tester-1", note: "3 found", noteTone: T.attn, depth: 1 },
  { glyph: "⠼", tone: T.accent, name: "tester-2", note: "8/18", depth: 1 },
  { glyph: "✓", tone: T.dim, name: "tester-3", note: "done", depth: 1, last: true, dim: true },
]
const Line = (p: Item & { guides?: boolean; width?: number }) => {
  const w = p.width ?? RW
  const depth = p.depth ?? 0
  const guide = depth === 0 ? "" : p.guides ? (p.last ? "└ " : "├ ") : "  "
  const note = p.note ?? ""
  const room = w - 1 - 1 - guide.length - 2 - note.length - 1
  return (
    <text wrapMode="none" {...(p.on ? { bg: T.sel } : {})}>
      <span fg={T.accent}>{p.on ? "▍" : " "}</span>
      <span fg={T.faint}>{` ${guide}`}</span>
      <span fg={p.tone}>{p.glyph}</span>
      <span fg={p.dim ? T.dim : T.text}>{p.on ? <b>{` ${pad(p.name, room)}`}</b> : ` ${pad(p.name, room)}`}</span>
      <span fg={p.noteTone ?? T.dim}>{`${note} `}</span>
    </text>
  )
}
/** A section's header: its label and a count, on a band (A), over a rule (B), or plain (C). */
const Section = (p: { label: string; count?: string; countTone?: string; style: "band" | "rule" | "plain"; width?: number }) => {
  const w = p.width ?? RW
  const count = p.count ?? ""
  const label = p.style === "plain" ? p.label : p.label.toUpperCase().split("").join(p.style === "band" ? "" : "")
  const gap = Math.max(1, w - 1 - label.length - count.length - 1)
  return p.style === "rule" ? (
    <text wrapMode="none">
      <span fg={T.dim}><b>{` ${label}`}</b></span>
      <span fg={T.faint}>{` ${"─".repeat(Math.max(1, w - 4 - label.length - count.length))} `}</span>
      <span fg={p.countTone ?? T.dim}>{`${count} `}</span>
    </text>
  ) : (
    <text wrapMode="none" {...(p.style === "band" ? { bg: T.line } : {})}>
      <span fg={p.style === "band" ? T.text : T.dim}><b>{` ${label}`}</b></span>
      <span>{" ".repeat(gap)}</span>
      <span fg={p.countTone ?? T.dim}>{`${count} `}</span>
    </text>
  )
}
/** zarg at the top: the name, then where you are. */
const Brand = (p: { band?: boolean }) => (
  <box style={{ flexDirection: "column", flexShrink: 0, ...(p.band ? { backgroundColor: T.bg } : {}), paddingTop: 1, paddingBottom: 1 }}>
    <text wrapMode="none"><span fg={T.accent}><b>{" ◆ zarg"}</b></span></text>
    <text wrapMode="none"><span fg={T.dim}>{"   zarg-v2 · main"}</span></text>
  </box>
)
/** Pinned to the bottom: archived agents, and the core. */
const Foot = (p: { rule?: boolean }) => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    {p.rule ? <text fg={T.line} wrapMode="none">{"─".repeat(RW)}</text> : null}
    <Line glyph="▸" tone={T.dim} name="Archived" note="2" dim />
    <text wrapMode="none"><span fg={T.ok}>{"  ●"}</span><span fg={T.dim}>{" core · idle"}</span></text>
  </box>
)
const Edge = () => (
  <box style={{ width: 1, flexShrink: 0, flexDirection: "column" }}>
    {Array.from({ length: 60 }, (_, i) => <text key={i} fg={T.line}>│</text>)}
  </box>
)
/** A: Explorer. Sections on bands, uppercase labels and counts; tree guides; a hairline edge. */
const RailA = () => (
  <box style={{ flexDirection: "row", flexShrink: 0 }}>
    <box style={{ width: RW, flexShrink: 0, flexDirection: "column", backgroundColor: T.raised }}>
      <Brand band />
      <Section label="Views" count="2" style="band" />
      {VIEWS.map((v) => <Line key={v.name} {...v} />)}
      <text> </text>
      <Section label="Agents" count="◆2" countTone={T.attn} style="band" />
      {TREE.map((a) => <Line key={a.name} {...a} guides />)}
      <box style={{ flexGrow: 1 }} />
      <Foot rule />
    </box>
    <Edge />
  </box>
)
/** B: Quiet. No fills: sections are uppercase labels on a rule; indentation, no guides. */
const RailB = () => (
  <box style={{ flexDirection: "row", flexShrink: 0 }}>
    <box style={{ width: RW, flexShrink: 0, flexDirection: "column", backgroundColor: T.raised }}>
      <Brand />
      <Section label="Views" count="2" style="rule" />
      {VIEWS.map((v) => <Line key={v.name} {...v} />)}
      <text> </text>
      <Section label="Agents" count="◆2" countTone={T.attn} style="rule" />
      {TREE.map((a) => <Line key={a.name} {...a} />)}
      <box style={{ flexGrow: 1 }} />
      <Foot />
    </box>
    <Edge />
  </box>
)
/** C: Blocks. Each section its own shaded block with space around it; the rail ground stays the page's. */
const Block = (p: { children: ReactNode }) => <box style={{ flexDirection: "column", flexShrink: 0, backgroundColor: T.raised, paddingTop: 1, paddingBottom: 1, marginBottom: 1 }}>{p.children}</box>
const RailC = () => (
  <box style={{ width: RW + 2, flexShrink: 0, flexDirection: "column", backgroundColor: T.bg, paddingLeft: 1, paddingRight: 1 }}>
    <Brand />
    <Block>
      <Section label="Views" style="plain" />
      {VIEWS.map((v) => <Line key={v.name} {...v} width={RW} />)}
    </Block>
    <Block>
      <Section label="Agents" count="◆2" countTone={T.attn} style="plain" />
      {TREE.map((a) => <Line key={a.name} {...a} guides width={RW} />)}
    </Block>
    <box style={{ flexGrow: 1 }} />
    <Foot />
  </box>
)
const CONCEPTS = { A: RailA, B: RailB, C: RailC } as const
const ConceptScreen = (p: { c: keyof typeof CONCEPTS }) => {
  const R = CONCEPTS[p.c]
  return (
    <box style={{ flexDirection: "row", width: "100%", height: "100%", backgroundColor: T.bg }}>
      <R />
      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        <JourneysView top="a" />
        <text wrapMode="none" bg={T.raised}><span fg={T.accent}>{" › "}</span><span fg={T.faint}>message zarg… (alt+m or /)</span></text>
        <text wrapMode="none"><span fg={T.faint}>{" ↑↓ move   r refresh   esc back   ^k jump"}</span></text>
      </box>
    </box>
  )
}

// ── The Journeys view ────────────────────────────────────────────────────
const JOURNEYS = [
  { name: "Reconcile", cards: 17 },
  { name: "Set up", cards: 25 },
  { name: "Talk with zarg", cards: 18 },
  { name: "Watch agents", cards: 11 },
  { name: "CLI actor", cards: 12 },
]
const Rule = (p: { title: string; focused?: boolean; dim?: string }) => (
  <text wrapMode="none">
    <span fg={p.focused ? T.accent : T.dim}><b>{p.title}</b></span>
    {p.dim !== undefined ? <span fg={T.dim}>{`  ${p.dim}`}</span> : null}
    <span fg={T.faint}>{` ${"─".repeat(200)}`}</span>
  </text>
)
const Table = (p: { width?: number }) => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <text fg={T.dim} wrapMode="none">{`   ${pad("journey", 18)}cards`}</text>
    {JOURNEYS.map((j, i) => (
      <text key={j.name} wrapMode="none" {...(i === 0 ? { bg: T.sel } : {})}>
        <span fg={T.accent}>{i === 0 ? "▍" : " "}</span>
        <span fg={T.text}>{`  ${pad(j.name, 18)}`}</span>
        <span fg={T.dim}>{String(j.cards).padStart(2)}</span>
      </text>
    ))}
  </box>
)
// The flow as the highlighter colours it: keywords accent, ids amber, comments dim.
const G = (p: { k?: string; t: string; c?: string }) => (
  <text wrapMode="none">
    {p.k !== undefined ? <span fg={T.accent}>{`  ${p.k.padEnd(5)} `}</span> : null}
    <span fg={T.text}>{p.t}</span>
    {p.c !== undefined ? <span fg={T.dim}>{`  # ${p.c}`}</span> : null}
  </text>
)
const Card = (p: { id: string; title: string; given: [string, string]; when: string; then: [string, string]; next?: string }) => (
  <box style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
    <text wrapMode="none"><span fg={T.attn}>{p.id}</span><span fg={T.text}>{` ${p.title}`}</span></text>
    <G k="Given" t={p.given[0]} c={p.given[1]} />
    <G k="When" t={p.when} />
    <G k="Then" t={p.then[0]} c={p.then[1]} />
    {p.next !== undefined ? <text wrapMode="none"><span fg={T.accent}>→ </span><span fg={T.attn}>{p.next}</span></text> : null}
  </box>
)
const Flow = () => (
  <box style={{ flexDirection: "column" }}>
    <Card id="C-0020" title="Reconcile picks up a change" given={["the operator changes the graph", "S-0018"]} when="the graph stays quiet for two seconds" then={["the Planner Agent plans the changed cards", "S-0019"]} next="C-0056" />
    <Card id="C-0056" title="Plans are written" given={["the Planner Agent plans the changed cards", "S-0019"]} when="the Planner Agent finishes every changed card" then={["the Implementer Agent works on the cards", "S-0020"]} next="C-0021 or C-0057 (branches)" />
  </box>
)
const JourneysView = (p: { top: Top }) => (
  <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>
    {p.top === "a" ? (
      <>
        <text wrapMode="none"><span fg={T.accent}><b>Journeys</b></span></text>
        <text fg={T.dim} wrapMode="none">5 journeys · 83 cards</text>
        <text> </text>
        <Table />
        <text> </text>
        <Rule title="Reconcile" dim="17 cards · J-0004" />
        <Flow />
      </>
    ) : p.top === "b" ? (
      <>
        <text wrapMode="none"><span fg={T.accent}><b>Journeys</b></span></text>
        <text> </text>
        <Rule title="All" focused dim="5" />
        <Table />
        <text> </text>
        <Rule title="Flow" dim="Reconcile · 17 cards" />
        <Flow />
      </>
    ) : (
      <>
        <text wrapMode="none"><span fg={T.accent}><b>Journeys</b></span><span fg={T.dim}>{"   5 journeys · 83 cards"}</span></text>
        <text> </text>
        <box style={{ flexDirection: "row", flexGrow: 1 }}>
          <box style={{ width: 28, flexShrink: 0, flexDirection: "column" }}>
            <Table />
          </box>
          <box style={{ width: 1, flexShrink: 0, flexDirection: "column" }}>
            {Array.from({ length: 30 }, (_, i) => <text key={i} fg={T.line}>│</text>)}
          </box>
          <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2 }}>
            <Rule title="Reconcile" dim="17 cards · J-0004" />
            <Flow />
          </box>
        </box>
      </>
    )}
  </box>
)

// ── The screen ───────────────────────────────────────────────────────────
const Screen = (p: { rail: Rail; top: Top; label?: string }) => (
  <box style={{ flexDirection: "row", width: "100%", height: "100%", backgroundColor: T.bg }}>
    <RailView v={p.rail} />
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <JourneysView top={p.top} />
      <text wrapMode="none" bg={T.raised}><span fg={T.accent}>{" › "}</span><span fg={T.faint}>message zarg… (alt+m or /)</span></text>
      <text wrapMode="none"><span fg={T.dim}>{` core · idle · main${p.label !== undefined ? `   ${p.label}` : ""}`}</span><span fg={T.faint}>{"   ↑↓ move   r refresh   esc back"}</span></text>
    </box>
  </box>
)

const RAILS: Record<Rail, string> = { 1: "rule, no nav header", 2: "blank + titled rule", 3: "Views / Agents + rule", 4: "shaded nav block + rule" }
const TOPS: Record<Top, string> = { a: "summary line, untitled table", b: "table titled All", c: "side by side" }

const Live = () => {
  const [rail, setRail] = useState<Rail>(1)
  const [top, setTop] = useState<Top>("a")
  useKeyboard((k) => {
    if (k.name === "q") process.exit(0)
    if (["1", "2", "3", "4"].includes(k.name)) setRail(Number(k.name) as Rail)
    if (["a", "b", "c"].includes(k.name)) setTop(k.name as Top)
  })
  return <Screen rail={rail} top={top} label={`rail ${rail}: ${RAILS[rail]} · view ${top}: ${TOPS[top]}   (1-4, a-c, q)`} />
}

if (process.argv.includes("--html")) {
  // The frames as HTML: every cell's colours and weight, straight from the renderer.
  const hex = (c: { r: number; g: number; b: number; a?: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const out: Record<string, string> = {}
  for (const c of ["A", "B", "C"] as const) {
    const t = await testRender(<ConceptScreen c={c} />, { width: 120, height: 32, exitOnCtrlC: false, exitSignals: [] })
    await t.renderOnce()
    out[c] = t.captureSpans().lines.map((l) => l.spans.map((sp) => `<span style="color:${hex(sp.fg)};background:${hex(sp.bg)}${sp.attributes & 1 ? ";font-weight:700" : ""}">${esc(sp.text)}</span>`).join("")).join("\n")
    t.renderer.destroy()
  }
  for (const [rail, top] of [[1, "a"], [2, "a"], [3, "a"], [1, "b"], [1, "c"]] as const) {
    const t = await testRender(<Screen rail={rail} top={top} />, { width: 120, height: 32, exitOnCtrlC: false, exitSignals: [] })
    await t.renderOnce()
    out[`${rail}${top}`] = t.captureSpans().lines.map((l) => l.spans.map((sp) => `<span style="color:${hex(sp.fg)};background:${hex(sp.bg)}${sp.attributes & 1 ? ";font-weight:700" : ""}">${esc(sp.text)}</span>`).join("")).join("\n")
    t.renderer.destroy()
  }
  await Bun.write(process.argv.at(-1)!, JSON.stringify(out))
} else if (process.argv.includes("--frames")) {
  for (const rail of [1, 2, 3, 4] as const)
    for (const top of ["a", "b", "c"] as const) {
      const t = await testRender(<Screen rail={rail} top={top} />, { width: 120, height: 32, exitOnCtrlC: false, exitSignals: [] })
      await t.renderOnce()
      console.log(`\n── rail ${rail} (${RAILS[rail]}) · view ${top} (${TOPS[top]}) ──\n${t.captureCharFrame()}`)
      t.renderer.destroy()
    }
} else createRoot(await createCliRenderer({ exitOnCtrlC: true, autoFocus: false })).render(<Live />)

export type { ReactNode }
