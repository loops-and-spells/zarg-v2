// THROWAWAY MOCKUP (never commit): rehearse's findings, readable notes. `--html <file>` writes the frames as HTML.
import { testRender } from "@opentui/react/test-utils"
import type { ReactNode } from "react"

const T = { bg: "#0f1115", raised: "#161a21", line: "#262b35", text: "#d7dce2", dim: "#6b7280", faint: "#3b4150", accent: "#7aa2f7", attn: "#e0af68", ok: "#9ece6a", err: "#f7768e", sel: "#1f2533", shade: "#1a1f28" }
const RW = 24
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s + " ".repeat(n - s.length))

const FINDINGS = [
  { id: "R-1e108f96", persona: "Operator", journey: "Set up", kind: "transition", card: "UX-0035", sev: "low", sug: "ask 0.75", note: "The prior step promised local-first ordering, but this step doesn't say the chosen model is local; I can't tell whether my choice was honoured." },
  { id: "R-16011c71", persona: "CLI actor", journey: "Reconcile", kind: "friction", card: "UX-0056", sev: "medium", sug: "fix 0.80", note: "The tester answered in prose: 'works on my machine' is not a result the planner can use; ask for a pass or fail." },
  { id: "R-1b0b968c", persona: "Operator", journey: "Set up", kind: "friction", card: "UX-0062", sev: "medium", sug: "ask 0.60", note: "The grant question names scope and target but not the choice set: approve, deny or defer. I don't know what 'later' means." },
  { id: "R-09a2f624", persona: "Operator", journey: "Set up", kind: "gap", card: "UX-0062", sev: "medium", sug: "ask 0.68", note: "No failure path when the operator denies, ignores, or defers the grant. The plugin just waits." },
  { id: "R-126f1a5d", persona: "Operator", journey: "Reconcile", kind: "feature", card: "UX-0059", sev: "medium", sug: "ask 1.00", note: "A guided setup prompt would be wanted here. Offer inline creation commands or auto-scaffold missing plan/implement models before refusal." },
  { id: "R-3c7702aa", persona: "Driver Agent", journey: "Set up", kind: "gap", card: "UX-0030", sev: "high", sug: "fix 0.91", note: "When the key is missing the driver offers setup, but never says which role needs it; with three roles I can't tell which to fix." },
]
const sevTone = (s: string) => (s === "high" ? T.err : s === "medium" ? T.attn : T.dim)

// ── Shell pieces ─────────────────────────────────────────────────────────
const Band = (p: { label: string; count: string; tone?: string }) => (
  <text wrapMode="none" bg={T.line}>
    <span fg={T.text}><b>{` ${p.label}`}</b></span>
    <span>{" ".repeat(RW - 1 - 1 - p.label.length - p.count.length - 1)}</span>
    <span fg={p.tone ?? T.dim}>{`${p.count} `}</span>
  </text>
)
const RailRow = (p: { glyph: string; tone: string; name: string; note: string; guide?: string; on?: boolean; noteTone?: string }) => {
  const g = p.guide ?? ""
  const room = RW - 1 - 6 - g.length - p.note.length
  return (
    <text wrapMode="none" {...(p.on ? { bg: T.sel } : {})}>
      <span fg={T.accent}>{p.on ? "▍" : " "}</span>
      <span fg={T.faint}>{` ${g}`}</span>
      <span fg={p.tone}>{p.glyph}</span>
      <span fg={T.text}>{p.on ? <b>{` ${pad(p.name, room)}`}</b> : ` ${pad(p.name, room)}`}</span>
      <span>{" "}</span>
      <span fg={p.noteTone ?? T.dim}>{`${p.note} `}</span>
    </text>
  )
}
const Rail = () => (
  <box style={{ width: RW, flexShrink: 0, flexDirection: "column", backgroundColor: T.raised, border: ["right"], borderColor: T.line }}>
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>{" ◆ zarg"}</b></span></text>
    <text fg={T.dim} wrapMode="none">{"   zarg-v2 · main"}</text>
    <text> </text>
    <Band label="VIEWS" count="1" />
    <RailRow glyph="▤" tone={T.dim} name="Journeys" note="" />
    <text> </text>
    <Band label="AGENTS" count="◆1" tone={T.attn} />
    <RailRow glyph="✓" tone={T.dim} name="zarg" note="done" />
    <RailRow glyph="⠼" tone={T.accent} name="rehearse" note="41/83" />
    <RailRow glyph="◆" tone={T.attn} name="tester-1" note="6 found" noteTone={T.attn} guide="├ " on />
    <RailRow glyph="✓" tone={T.dim} name="tester-2" note="done" guide="└ " />
  </box>
)
const Heading = (p: { title: string; right?: string }) => (
  <text wrapMode="none">
    <span fg={T.accent}><b>{p.title}</b></span>
    {p.right !== undefined ? <span fg={T.dim}>{`  ${p.right}`}</span> : null}
    <span fg={T.faint}>{` ${"─".repeat(200)}`}</span>
  </text>
)
const Tabs = () => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <text wrapMode="none">
      <span fg={T.accent}><b>Findings 6</b></span>
      <span fg={T.dim}>{"   Likes 2"}</span>
      <span fg={T.faint}>{` ${"─".repeat(200)}`}</span>
    </text>
    <text fg={T.accent} wrapMode="none">{"▔".repeat(10)}</text>
  </box>
)
const Buttons = () => (
  <text wrapMode="none">
    <span fg={T.accent}>{" ▐"}</span><span fg={T.bg} bg={T.accent}>{" Send to zarg · 2 "}</span><span fg={T.raised} bg={T.accent}>{" a "}</span><span fg={T.accent}>{"▌"}</span>
    <span>{"  "}</span>
    <span fg={T.line}>{"▐"}</span><span fg={T.text} bg={T.line}>{" Dismiss "}</span><span fg={T.dim} bg={T.line}>{" d "}</span><span fg={T.line}>{"▌"}</span>
    <span fg={T.dim}>{"   Clear"}</span>
  </text>
)
const Header = () => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <text wrapMode="none"><span fg={T.accent}><b>tester-1</b></span><span fg={T.dim}>{"  rehearse · Operator"}</span></text>
    <text fg={T.dim} wrapMode="none">{"running · 41/83 steps · 6 findings"}</text>
    <text> </text>
  </box>
)
/** The search field over the list: idle, or a query with how many findings match. */
const Search = (p: { query?: string; matches?: number }) =>
  p.query === undefined ? (
    <text wrapMode="none" bg={T.raised}>
      <span fg={T.dim}>{" ⌕ "}</span>
      <span fg={T.faint}>{pad("search findings: card, journey, persona, note…", 40)}</span>
      <span fg={T.faint}>{"   f"}</span>
    </text>
  ) : (
    <text wrapMode="none" bg={T.sel}>
      <span fg={T.accent}>{" ⌕ "}</span>
      <span fg={T.text}>{p.query}</span>
      <span fg={T.accent}>▎</span>
      <span>{" ".repeat(Math.max(1, 40 - p.query.length - 1))}</span>
      <span fg={T.dim}>{`${p.matches} of 6   esc`}</span>
    </text>
  )
/** Text with the query's words marked (amber on the selection shade). */
const Marked = (p: { text: string; query?: string; fg: string }) => {
  if (p.query === undefined) return <span fg={p.fg}>{p.text}</span>
  const re = new RegExp(`(${p.query.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}\\w*)`, "gi")
  return <>{p.text.split(re).map((part, i) => (i % 2 === 1 ? <span key={i} fg={T.attn} bg={T.sel}>{part}</span> : <span key={i} fg={p.fg}>{part}</span>))}</>
}
const RunHeader = () => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <text wrapMode="none"><span fg={T.accent}><b>rehearse</b></span><span fg={T.dim}>{"  run r-4f2a · 3 personas"}</span></text>
    <text fg={T.dim} wrapMode="none">{"running · 41/83 steps · 6 findings"}</text>
    <text> </text>
  </box>
)
const Mark = (p: { on: boolean; picked: boolean }) => (
  <>
    <span fg={T.accent}>{p.on ? "▍" : " "}</span>
    <span fg={p.picked ? T.accent : T.dim}>{p.picked ? "● " : "○ "}</span>
  </>
)
const PICKED = new Set(["R-1b0b968c", "R-09a2f624"])
const CURSOR = 2

// ── A: list left (no notes), the highlighted finding in full on the right ──
const Detail = (p: { f: (typeof FINDINGS)[number]; query?: string }) => (
  <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, border: ["left"], borderColor: T.line }}>
    <text><span fg={T.attn}>{p.f.card}</span><span fg={T.faint}>{`  ${p.f.id}`}</span></text>
    <text fg={T.text}><b>Plugin asks for an optional scope</b></text>
    <text><span fg={T.dim}>{"by "}</span><span fg={T.accent}>{p.f.persona}</span><span fg={T.dim}>{" · in "}</span><span fg={T.ok}>{p.f.journey}</span></text>
    <text><span fg={T.text}>{p.f.kind}</span><span fg={T.dim}>{" · "}</span><span fg={sevTone(p.f.sev)}>{p.f.sev}</span><span fg={T.dim}>{` · suggest ${p.f.sug}`}</span></text>
    <text> </text>
    <text><Marked text={p.f.note} fg={T.text} {...(p.query !== undefined ? { query: p.query } : {})} /></text>
    <text> </text>
    <text><span fg={T.accent}>{"Given "}</span><span fg={T.text}>{"the plugin runs"}</span></text>
    <text><span fg={T.accent}>{"When  "}</span><span fg={T.text}>{"the plugin needs a scope it may ask for"}</span></text>
    <text><span fg={T.accent}>{"Then  "}</span><span fg={T.text}>{"the operator is asked: once, always, deny"}</span></text>
  </box>
)
const SplitList = (p: { by: "journey" | "persona"; only?: ReadonlyArray<string>; cursor?: number }) => (
  <box style={{ width: 47, flexShrink: 0, flexDirection: "column" }}>
    <text fg={T.dim} wrapMode="none">{`   ${pad("card", 9)}${pad(p.by, 13)}${pad("kind", 11)}sev`}</text>
    {FINDINGS.filter((f) => p.only === undefined || p.only.includes(f.id)).map((f, i) => (
      <text key={f.id} wrapMode="none" {...(i === (p.cursor ?? CURSOR) ? { bg: T.sel } : {})}>
        <Mark on={i === (p.cursor ?? CURSOR)} picked={PICKED.has(f.id)} />
        <span fg={T.attn}>{pad(f.card, 9)}</span>
        <span fg={p.by === "persona" ? T.accent : T.ok}>{pad(p.by === "persona" ? f.persona : f.journey, 13)}</span>
        <span fg={T.text}>{pad(f.kind, 11)}</span>
        <span fg={sevTone(f.sev)}>{f.sev}</span>
      </text>
    ))}
  </box>
)
const ViewA = (p: { by: "journey" | "persona"; query?: string }) => (
  <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>
    {p.by === "journey" ? <Header /> : <RunHeader />}
    <Tabs />
    <Search {...(p.query !== undefined ? { query: p.query, matches: 2 } : {})} />
    <text> </text>
    <box style={{ flexDirection: "row", flexShrink: 0 }}>
      <SplitList by={p.by} {...(p.query !== undefined ? { only: ["R-1b0b968c", "R-09a2f624"], cursor: 0 } : {})} />
      <Detail f={FINDINGS[CURSOR]!} {...(p.query !== undefined ? { query: p.query } : {})} />
    </box>
    <text> </text>
    <Buttons />
  </box>
)

// ── B: two-line rows: the columns, then the note under them (dim, up to two lines) ──
const wrap2 = (t: string, w: number) => {
  const words = t.split(" ")
  const lines: Array<string> = [""]
  for (const word of words) {
    if ((lines.at(-1)! + " " + word).trim().length > w) {
      if (lines.length === 2) {
        lines[1] = pad(lines[1]!, w - 1) + "…"
        return lines
      }
      lines.push(word)
    } else lines[lines.length - 1] = (lines.at(-1)! + " " + word).trim()
  }
  return lines
}
const ViewB = (p: { width: number }) => (
  <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>
    <Header />
    <Tabs />
    <text fg={T.dim} wrapMode="none">{`   ${pad("card", 9)}${pad("kind", 12)}${pad("severity", 10)}${pad("suggested", 11)}id`}</text>
    {FINDINGS.slice(0, 5).map((f, i) => (
      <box key={f.id} style={{ flexDirection: "column", flexShrink: 0, ...(i === CURSOR ? { backgroundColor: T.sel } : {}) }}>
        <text wrapMode="none">
          <Mark on={i === CURSOR} picked={PICKED.has(f.id)} />
          <span fg={T.attn}>{pad(f.card, 9)}</span>
          <span fg={T.text}>{pad(f.kind, 12)}</span>
          <span fg={sevTone(f.sev)}>{pad(f.sev, 10)}</span>
          <span fg={T.dim}>{pad(f.sug, 11)}</span>
          <span fg={T.faint}>{f.id}</span>
        </text>
        {wrap2(f.note, p.width).map((l, k) => (
          <text key={k} wrapMode="none"><span fg={T.accent}>{i === CURSOR ? "▍" : " "}</span><span fg={i === CURSOR ? T.text : T.dim}>{`  ${l}`}</span></text>
        ))}
      </box>
    ))}
    <text> </text>
    <Buttons />
  </box>
)

// ── C: both — two-line rows on the left, the full finding and its card on the right ──
const ViewC = () => (
  <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>
    <Header />
    <Tabs />
    <box style={{ flexDirection: "row", flexShrink: 0 }}>
      <box style={{ width: 46, flexShrink: 0, flexDirection: "column" }}>
        {FINDINGS.slice(0, 5).map((f, i) => (
          <box key={f.id} style={{ flexDirection: "column", flexShrink: 0, ...(i === CURSOR ? { backgroundColor: T.sel } : {}) }}>
            <text wrapMode="none">
              <Mark on={i === CURSOR} picked={PICKED.has(f.id)} />
              <span fg={T.attn}>{pad(f.card, 9)}</span>
              <span fg={T.text}>{pad(f.kind, 12)}</span>
              <span fg={sevTone(f.sev)}>{pad(f.sev, 8)}</span>
              <span fg={T.dim}>{f.sug}</span>
            </text>
            <text wrapMode="none"><span fg={T.accent}>{i === CURSOR ? "▍" : " "}</span><span fg={T.dim}>{`  ${pad(f.note, 41)}`}</span></text>
          </box>
        ))}
      </box>
      <Detail f={FINDINGS[CURSOR]!} />
    </box>
    <text> </text>
    <Buttons />
  </box>
)

const Screen = (p: { children: ReactNode }) => (
  <box style={{ flexDirection: "row", width: "100%", height: "100%", backgroundColor: T.bg }}>
    <Rail />
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "column" }}>{p.children}</box>
      <text wrapMode="none" bg={T.raised}><span fg={T.accent}>{" › "}</span><span fg={T.faint}>message zarg… (alt+m or /)</span></text>
      <text wrapMode="none"><span fg={T.dim}>{" core · running · main"}</span><span fg={T.faint}>{"                                                              esc back"}</span></text>
    </box>
  </box>
)

const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const out: Record<string, string> = {}
for (const [k, node] of [["A1", <ViewA by="journey" />], ["A1q", <ViewA by="journey" query="grant" />]] as const) {
  const t = await testRender(<Screen>{node}</Screen>, { width: 120, height: 30, exitOnCtrlC: false, exitSignals: [] })
  await t.renderOnce()
  out[k] = t.captureSpans().lines.map((l) => l.spans.map((sp) => `<span style="color:${hex(sp.fg)};background:${hex(sp.bg)}${sp.attributes & 1 ? ";font-weight:700" : ""}">${esc(sp.text)}</span>`).join("")).join("\n")
  if (!process.argv.includes("--html")) console.log(`\n── ${k} ──\n${t.captureCharFrame()}`)
  t.renderer.destroy()
}
if (process.argv.includes("--html")) await Bun.write(process.argv.at(-1)!, JSON.stringify(out))
