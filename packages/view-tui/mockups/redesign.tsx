// THROWAWAY MOCKUP (never commit): approach A (rail + one focus, borderless) with a paginated grid of agent views and
// zarg's bar that drops into a sheet. Frames: `mise x -- bun packages/view-tui/mockups/redesign.tsx`.
// Live (colour, pulse, keys 1-6, q quits): add `--live`.
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { type ReactNode, useEffect, useState } from "react"

// One theme: a dark ground, one accent, attention amber, and dimming for hierarchy.
const T = { bg: "#0f1115", raised: "#161a21", line: "#262b35", text: "#d7dce2", dim: "#6b7280", faint: "#3b4150", accent: "#7aa2f7", attn: "#e0af68", ok: "#9ece6a", err: "#f7768e", sel: "#1f2533" }

const Rule = (p: { title?: string; right?: string; focused?: boolean }) => (
  <text wrapMode="none">
    <span fg={p.focused ? T.accent : T.dim}><b>{p.title ?? ""}</b></span>
    <span fg={T.faint}>{` ${"─".repeat(200)}`}</span>
  </text>
)
const Gauge = (p: { done: number; total: number; width: number; tone?: string }) => {
  const f = Math.round((p.done / Math.max(1, p.total)) * p.width)
  return (
    <text wrapMode="none">
      <span fg={p.tone ?? T.accent}>{"━".repeat(f)}</span>
      <span fg={T.faint}>{"━".repeat(p.width - f)}</span>
    </text>
  )
}

// The rail: agents by status glyph, short name, a hairline gauge, ◆ that pulses until seen.
type RailRow = { glyph: string; name: string; tone: string; note: string; attn?: boolean; sel?: boolean; depth?: number; gauge?: [number, number] }
const RAIL: ReadonlyArray<RailRow> = [
  { glyph: "◆", name: "zarg", tone: T.attn, note: "asks", attn: true },
  { glyph: "⠼", name: "driver", tone: T.accent, note: "3/25", depth: 1 },
  { glyph: "⠼", name: "rehearse", tone: T.accent, note: "12/18", gauge: [12, 18] },
  { glyph: "◆", name: "tester-1", tone: T.attn, note: "3 found", attn: true, depth: 1, sel: true },
  { glyph: "✓", name: "tester-2", tone: T.dim, note: "done", depth: 1 },
  { glyph: "⠼", name: "tester-3", tone: T.accent, note: "8/18", depth: 1, gauge: [8, 18] },
]
const Rail = (p: { tick: number; focused?: boolean; selected?: string }) => (
  <box style={{ width: 24, flexShrink: 0, flexDirection: "column", paddingLeft: 1, paddingRight: 1, backgroundColor: T.raised }}>
    <text wrapMode="none"><span fg={p.focused ? T.accent : T.dim}><b>agents</b></span><span fg={T.attn}>{"  ◆2"}</span></text>
    <text> </text>
    {RAIL.map((r) => {
      const on = !r.attn || p.tick % 2 === 0
      const sel = p.selected !== undefined ? r.name === p.selected : r.sel === true
      return (
        <box key={r.name} style={{ flexDirection: "column" }}>
          <text wrapMode="none" {...(sel ? { bg: T.sel } : {})}>
            <span fg={T.faint}>{"  ".repeat(r.depth ?? 0)}</span>
            <span fg={on ? r.tone : T.faint}>{r.glyph} </span>
            <span fg={sel ? T.text : r.tone === T.dim ? T.dim : T.text}>{sel ? <b>{r.name}</b> : r.name}</span>
            <span fg={T.dim}>{r.note.padStart(Math.max(1, 21 - (r.depth ?? 0) * 2 - r.name.length - 2))}</span>
          </text>
          {r.gauge ? (
            <box style={{ paddingLeft: (r.depth ?? 0) * 2 + 2 }}>
              <Gauge done={r.gauge[0]} total={r.gauge[1]} width={16 - (r.depth ?? 0) * 2} />
            </box>
          ) : null}
        </box>
      )
    })}
    <box style={{ flexGrow: 1 }} />
    <text fg={T.dim} wrapMode="none">▸ archived 4</text>
  </box>
)

// The one strip at the bottom: zarg's bar (or its question), then the status line with the keys of what has focus.
const Bottom = (p: { bar: ReactNode; keys: string; status?: string }) => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <box style={{ height: 1, flexDirection: "row", backgroundColor: T.raised, paddingLeft: 1 }}>{p.bar}</box>
    <text wrapMode="none" truncate>
      <span fg={T.dim}>{` ${p.status ?? "core · main · YOLO off"}`}</span>
      <span fg={T.faint}>{"   "}</span>
      <span fg={T.dim}>{p.keys}</span>
    </text>
  </box>
)
const Ask = () => (
  <text wrapMode="none">
    <span fg={T.attn}>◆ zarg asks </span>
    <span fg={T.text}>Split C-0012 into two cards?</span>
    <span fg={T.dim}>{"   ⏎ answer   / chat"}</span>
  </text>
)
const Typing = () => (
  <text wrapMode="none">
    <span fg={T.accent}>› </span>
    <span fg={T.text}>keep them separate, one per outcome</span>
    <span fg={T.accent}>▎</span>
  </text>
)

// Focus: zarg's conversation, borderless; the question sits at its foot, options as a list.
const Conversation = () => (
  <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
    <Rule title="zarg" focused />
    <text> </text>
    <text wrapMode="word"><span fg={T.dim}>you   </span><span fg={T.text}>rehearse the checkout journey</span></text>
    <text> </text>
    <text wrapMode="word"><span fg={T.accent}>zarg  </span><span fg={T.text}>tester-1 walked 18 steps and found 3 gaps. C-0012 mixes two outcomes (paid, declined) in one card.</span></text>
    <box style={{ flexGrow: 1 }} />
    <text fg={T.attn}><b>Split C-0012 into two cards?</b></text>
    <text> </text>
    <text wrapMode="none" bg={T.sel}><span fg={T.accent}>› </span><span fg={T.text}>Yes, one card per outcome</span><span fg={T.dim}>   each outcome gets its own Then</span></text>
    <text wrapMode="none"><span fg={T.text}>  Keep as is</span></text>
    <text wrapMode="none"><span fg={T.dim}>  Something else…</span></text>
    <text wrapMode="none"><span fg={T.dim}>  Chat about this</span></text>
    <text> </text>
  </box>
)

// Focus: one agent's view, sections as headed blocks, no nested frames.
const AgentFocus = () => (
  <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
    <text wrapMode="none"><span fg={T.accent}><b>tester-1</b></span><span fg={T.dim}>  rehearse · checkout · the impatient shopper</span></text>
    <text> </text>
    <box style={{ flexDirection: "row" }}>
      <Gauge done={12} total={18} width={30} />
      <text wrapMode="none"><span fg={T.text}>{"  12/18 steps"}</span><span fg={T.dim}>{"   3 findings   1.6 avg feel"}</span></text>
    </box>
    <text> </text>
    <Rule title="findings 3" focused />
    <text wrapMode="none" bg={T.sel}><span fg={T.accent}>▍</span><span fg={T.text}>{" ☐ C-0012  "}</span><span fg={T.err}>high  </span><span fg={T.text}>no way back from payment</span></text>
    <text wrapMode="none"><span fg={T.text}>{"  ☐ C-0019  "}</span><span fg={T.attn}>med   </span><span fg={T.text}>empty cart shows a spinner forever</span></text>
    <text wrapMode="none"><span fg={T.text}>{"  ☐ C-0023  "}</span><span fg={T.dim}>low   </span><span fg={T.text}>login error names the wrong field</span></text>
    <text> </text>
    <Rule title="steps" />
    <text wrapMode="none"><span fg={T.ok}>✓ </span><span fg={T.dim}>C-0010  </span><span fg={T.text}>cart → checkout</span><span fg={T.dim}>   feel 1.9</span></text>
    <text wrapMode="none"><span fg={T.ok}>✓ </span><span fg={T.dim}>C-0011  </span><span fg={T.text}>checkout → address</span><span fg={T.dim}>   feel 1.7</span></text>
    <text wrapMode="none"><span fg={T.attn}>⚑ </span><span fg={T.dim}>C-0012  </span><span fg={T.text}>address → payment</span><span fg={T.dim}>   feel 0.8  flagged</span></text>
    <box style={{ flexGrow: 1 }} />
  </box>
)

// The grid: agent views as cards, paginated. Each card: name, gauge, the one line that matters, ◆ if it asks.
type Card = { name: string; sub: string; done: number; total: number; line: string; attn?: string; state: "run" | "done" | "attn"; recent: ReadonlyArray<string> }
const CARDS: ReadonlyArray<Card> = [
  { name: "tester-1", sub: "impatient shopper", done: 18, total: 18, line: "3 findings to review", attn: "3 findings", state: "attn", recent: ["high  C-0012 no way back from payment", "med   C-0019 spinner forever", "low   C-0023 wrong field named"] },
  { name: "tester-2", sub: "careful first-timer", done: 18, total: 18, line: "no findings · 1.9 avg feel", state: "done", recent: ["✓ C-0031 search → results  1.9", "✓ C-0032 results → item  2.0"] },
  { name: "tester-3", sub: "returning customer", done: 8, total: 18, line: "walking C-0019", state: "run", recent: ["✓ C-0010 cart → checkout  1.8", "✓ C-0011 checkout → address  1.7", "⠼ C-0019 empty cart…"] },
  { name: "driver", sub: "zarg · rlm-1", done: 3, total: 25, line: "turn 3 of 25", state: "run", recent: ["Graph.render C-0012", "Inquire.ask Split C-0012?"] },
]
const CardView = (p: { c: Card; sel?: boolean; tick: number }) => {
  const tone = p.c.state === "attn" ? T.attn : p.c.state === "done" ? T.ok : T.accent
  const glyph = p.c.state === "attn" ? (p.tick % 2 === 0 ? "◆" : "◇") : p.c.state === "done" ? "✓" : "⠼"
  return (
    <box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", paddingLeft: 1, paddingRight: 1, border: true, borderStyle: "rounded", borderColor: p.sel ? T.accent : T.line }}>
      <text wrapMode="none"><span fg={tone}>{glyph} </span><span fg={T.text}><b>{p.c.name}</b></span><span fg={T.dim}>{`  ${p.c.sub}`}</span></text>
      <box style={{ flexDirection: "row" }}>
        <Gauge done={p.c.done} total={p.c.total} width={22} tone={tone} />
        <text fg={T.dim} wrapMode="none">{`  ${p.c.done}/${p.c.total}`}</text>
      </box>
      <text wrapMode="none" fg={p.c.attn ? T.attn : T.text}>{p.c.line}</text>
      <text> </text>
      {p.c.recent.map((l, i) => (
        <text key={i} wrapMode="none" fg={T.dim}>{l}</text>
      ))}
      <box style={{ flexGrow: 1 }} />
      <text fg={T.faint} wrapMode="none">{p.c.state === "attn" ? "⏎ open   a apply all" : "⏎ open"}</text>
    </box>
  )
}
const Grid = (p: { tick: number }) => (
  <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
    <text wrapMode="none"><span fg={T.accent}><b> all agents</b></span><span fg={T.dim}>{"   rehearse r-3f2a · page 1 of 2"}</span><span fg={T.faint}>{"   ●○"}</span></text>
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <CardView c={CARDS[0]!} sel tick={p.tick} />
        <CardView c={CARDS[1]!} tick={p.tick} />
      </box>
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <CardView c={CARDS[2]!} tick={p.tick} />
        <CardView c={CARDS[3]!} tick={p.tick} />
      </box>
    </box>
  </box>
)

// zarg's sheet dropped over whatever has focus (here the grid): the conversation slides up from the bar.
const Sheet = () => (
  <box style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 13, flexDirection: "column", paddingLeft: 2, paddingRight: 2, backgroundColor: T.raised, border: ["top"], borderColor: T.accent }}>
    <text wrapMode="none"><span fg={T.accent}><b>zarg</b></span><span fg={T.dim}>{"   esc closes · the grid stays behind"}</span></text>
    <text> </text>
    <text wrapMode="word"><span fg={T.accent}>zarg  </span><span fg={T.text}>tester-1 found 3 gaps. C-0012 mixes two outcomes.</span></text>
    <text> </text>
    <text fg={T.attn}><b>Split C-0012 into two cards?</b></text>
    <text wrapMode="none" bg={T.sel}><span fg={T.accent}>› </span><span fg={T.text}>Yes, one card per outcome</span><span fg={T.dim}>   recommended</span></text>
    <text wrapMode="none"><span fg={T.text}>  Keep as is</span></text>
    <text wrapMode="none"><span fg={T.dim}>  Something else…   Chat about this</span></text>
  </box>
)

// The review queue: every finding from every agent in one list, triaged with a keystroke.
const Review = () => (
  <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
    <text wrapMode="none"><span fg={T.accent}><b>review</b></span><span fg={T.dim}>{"   5 open · 2 agents"}</span></text>
    <text> </text>
    <Rule title="tester-1" />
    <text wrapMode="none" bg={T.sel}><span fg={T.accent}>▍</span><span fg={T.text}>{" ☐ C-0012  "}</span><span fg={T.err}>high  </span><span fg={T.text}>no way back from payment</span></text>
    <text wrapMode="none"><span fg={T.text}>{"  ☐ C-0019  "}</span><span fg={T.attn}>med   </span><span fg={T.text}>empty cart shows a spinner forever</span></text>
    <text wrapMode="none"><span fg={T.text}>{"  ☐ C-0023  "}</span><span fg={T.dim}>low   </span><span fg={T.text}>login error names the wrong field</span></text>
    <text> </text>
    <Rule title="tester-3" />
    <text wrapMode="none"><span fg={T.text}>{"  ☐ C-0031  "}</span><span fg={T.attn}>med   </span><span fg={T.text}>search ignores the category filter</span></text>
    <text wrapMode="none"><span fg={T.text}>{"  ☐ C-0033  "}</span><span fg={T.dim}>low   </span><span fg={T.text}>sort order resets on back</span></text>
    <box style={{ flexGrow: 1 }} />
  </box>
)

// ctrl+k: jump anywhere (agents, views, commands, the review queue) by typing.
const Palette = () => (
  <box style={{ position: "absolute", left: 30, top: 3, width: 60, height: 12, flexDirection: "column", paddingLeft: 1, paddingRight: 1, backgroundColor: T.raised, border: true, borderStyle: "rounded", borderColor: T.accent }}>
    <text wrapMode="none"><span fg={T.accent}>› </span><span fg={T.text}>tes</span><span fg={T.accent}>▎</span></text>
    <text fg={T.faint} wrapMode="none">{"─".repeat(56)}</text>
    <text wrapMode="none" bg={T.sel}><span fg={T.attn}>◆ </span><span fg={T.text}><b>tes</b>ter-1</span><span fg={T.dim}>{"          3 findings to review"}</span></text>
    <text wrapMode="none"><span fg={T.accent}>⠼ </span><span fg={T.text}><b>tes</b>ter-3</span><span fg={T.dim}>{"          8/18 steps"}</span></text>
    <text wrapMode="none"><span fg={T.ok}>✓ </span><span fg={T.text}><b>tes</b>ter-2</span><span fg={T.dim}>{"          done"}</span></text>
    <text wrapMode="none"><span fg={T.dim}>/ </span><span fg={T.text}>rehearse · run <b>tes</b>ters on the journeys</span></text>
    <text wrapMode="none"><span fg={T.dim}>▦ </span><span fg={T.text}>grid · all agents</span></text>
    <text wrapMode="none"><span fg={T.dim}>☐ </span><span fg={T.text}>review · 5 open</span></text>
  </box>
)

type Frame = { name: string; main: "chat" | "agent" | "grid" | "review"; bar: "ask" | "typing"; keys: string; sheet?: boolean; palette?: boolean; rail?: string }
const FRAMES: ReadonlyArray<Frame> = [
  { name: "1. focus: zarg's conversation — borderless, the question at its foot", main: "chat", bar: "typing", keys: "↑↓ pick   ⏎ answer   ⇥ back   ^k jump", rail: "zarg" },
  { name: "2. focus: one agent's view — headed blocks, no nested frames; zarg's question waits in the bar", main: "agent", bar: "ask", keys: "↑↓ move   ␣ select   a apply   d dismiss   ⇥ back   ^k jump" },
  { name: "3. grid: agent views as cards, paginated (▸/◂ pages); ◆ pulses on the one that needs you", main: "grid", bar: "ask", keys: "←→↑↓ move   ⏎ open   ]/[ page   a apply all   ^k jump" },
  { name: "4. grid + zarg dropped in: the sheet slides up from the bar, the grid stays behind", main: "grid", bar: "typing", sheet: true, keys: "↑↓ pick   ⏎ answer   esc close" },
  { name: "5. review: every finding from every agent in one queue", main: "review", bar: "ask", keys: "↑↓ move   ␣ select   a apply   d dismiss   ⏎ open agent   ^k jump" },
  { name: "6. ^k palette: jump to any agent, view, command or the review queue by typing", main: "grid", bar: "ask", palette: true, keys: "↑↓ pick   ⏎ go   esc close" },
]

const Shell = (p: { f: Frame; tick: number }) => (
  <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: T.bg }}>
    <box style={{ flexGrow: 1, flexDirection: "row" }}>
      <Rail tick={p.tick} {...(p.f.rail !== undefined ? { selected: p.f.rail } : {})} />
      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        {p.f.main === "chat" ? <Conversation /> : p.f.main === "agent" ? <AgentFocus /> : p.f.main === "grid" ? <Grid tick={p.tick} /> : <Review />}
        {p.f.sheet ? <Sheet /> : null}
      </box>
    </box>
    <Bottom bar={p.f.bar === "ask" ? <Ask /> : <Typing />} keys={p.f.keys} />
    {p.f.palette ? <Palette /> : null}
  </box>
)

const Live = () => {
  const [i, setI] = useState(0)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [])
  useKeyboard((k) => {
    if (k.name === "q") process.exit(0)
    const n = Number(k.name)
    if (n >= 1 && n <= FRAMES.length) setI(n - 1)
  })
  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: T.bg }}>
      <text fg={T.accent} wrapMode="none">{`${FRAMES[i]!.name}   (1-6 frames · q quit)`}</text>
      <Shell f={FRAMES[i]!} tick={tick} />
    </box>
  )
}

if (process.argv.includes("--live")) createRoot(await createCliRenderer({ exitOnCtrlC: true, autoFocus: false })).render(<Live />)
else
  for (const f of FRAMES) {
    const t = await testRender(<Shell f={f} tick={0} />, { width: 120, height: 26, exitOnCtrlC: false, exitSignals: [] })
    await t.renderOnce()
    await t.renderOnce()
    console.log(`\n=== ${f.name} ===\n${t.captureCharFrame()}`)
    t.renderer.destroy()
  }
