// THROWAWAY MOCKUP (never commit): Feedback, Backlog (kanban), and the rehearse / tester views without triage.
import { testRender } from "@opentui/react/test-utils"
import type { ReactNode } from "react"

const T = { bg: "#0f1115", raised: "#161a21", line: "#262b35", text: "#d7dce2", dim: "#6b7280", faint: "#3b4150", accent: "#7aa2f7", attn: "#e0af68", ok: "#9ece6a", err: "#f7768e", sel: "#1f2533", shade: "#1a1f28" }
const RW = 24
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s + " ".repeat(Math.max(0, n - s.length)))
const wrap = (t: string, w: number, max = 99) => {
  const lines: Array<string> = [""]
  const words = t.split(" ")
  for (let i = 0; i < words.length; i++) {
    const next = `${lines.at(-1)!} ${words[i]}`.trim()
    if (next.length <= w) lines[lines.length - 1] = next
    else if (lines.length === max) {
      lines[lines.length - 1] = `${next.slice(0, w - 1)}…`
      return lines
    } else lines.push(words[i]!)
  }
  return lines
}
const sevTone = (s: string) => (s === "high" ? T.err : s === "medium" ? T.attn : T.dim)

const FEEDBACK = [
  { id: "F-3c77", card: "S-0030", hash: "a41e", persona: "Driver Agent", journey: "Set up", kind: "gap", sev: "high", from: "tester-3", age: "2h", status: "open", note: "When the key is missing the driver offers setup, but never says which role needs it; with three roles I can't tell which to fix." },
  { id: "F-1601", card: "S-0056", hash: "77c0", persona: "CLI actor", journey: "Reconcile", kind: "friction", sev: "medium", from: "tester-2", age: "2h", status: "open", note: "The tester answered in prose: 'works on my machine' is not a result the planner can use; ask for a pass or fail." },
  { id: "F-1b0b", card: "S-0062", hash: "3f9a", persona: "Operator", journey: "Set up", kind: "friction", sev: "medium", from: "tester-1", age: "3h", status: "open", note: "The grant question names scope and target but not the choice set: approve, deny or defer. I don't know what 'later' means." },
  { id: "F-09a2", card: "S-0062", hash: "3f9a", persona: "Operator", journey: "Set up", kind: "gap", sev: "medium", from: "tester-1", age: "3h", status: "open", note: "No failure path when the operator denies, ignores, or defers the grant. The plugin just waits." },
  { id: "F-126f", card: "S-0059", hash: "c802", persona: "Operator", journey: "Reconcile", kind: "feature", sev: "medium", from: "tester-1", age: "1d", status: "open", note: "A guided setup prompt would be wanted here. Offer inline creation commands or auto-scaffold missing plan/implement models." },
  { id: "F-1e10", card: "S-0035", hash: "5d13", persona: "Operator", journey: "Set up", kind: "transition", sev: "low", from: "tester-1", age: "1d", status: "open", note: "The prior step promised local-first ordering, but this step doesn't say the chosen model is local." },
]
const STALE = [
  { id: "F-44d0", card: "S-0041", was: "9e2b", now: "d017", persona: "Operator", journey: "Review", kind: "gap", sev: "high", from: "tester-2", age: "2d", note: "Rejecting a plan gives no way to say why; the planner will redo the same plan." },
  { id: "F-2a19", card: "S-0041", was: "9e2b", now: "d017", persona: "Operator", journey: "Review", kind: "friction", sev: "low", from: "tester-1", age: "2d", note: "'Reject' and 'Revise' read the same; which one keeps my notes?" },
]

// ── Shell ────────────────────────────────────────────────────────────────
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
type Where = "feedback" | "backlog" | "rehearse" | "tester"
const Rail = (p: { at: Where }) => (
  <box style={{ width: RW, flexShrink: 0, flexDirection: "column", backgroundColor: T.raised, border: ["right"], borderColor: T.line }}>
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>{" ◆ zarg"}</b></span></text>
    <text fg={T.dim} wrapMode="none">{"   zarg-v2 · main"}</text>
    <text> </text>
    <Band label="VIEWS" count="3" />
    <RailRow glyph="▤" tone={T.dim} name="Journeys" note="5" />
    <RailRow glyph="◇" tone={p.at === "feedback" ? T.accent : T.attn} name="Feedback" note="6" noteTone={T.attn} on={p.at === "feedback"} />
    <RailRow glyph="▦" tone={p.at === "backlog" ? T.accent : T.dim} name="Backlog" note="11" on={p.at === "backlog"} />
    <text> </text>
    <Band label="AGENTS" count="4" />
    <RailRow glyph="✓" tone={T.dim} name="zarg" note="done" />
    <RailRow glyph="⠼" tone={T.accent} name="Implementer" note="B-07" />
    <RailRow glyph="✓" tone={T.dim} name="rehearse" note="done" on={p.at === "rehearse"} />
    <RailRow glyph="✓" tone={T.dim} name="tester-1" note="4 fb" guide="├ " on={p.at === "tester"} />
    <RailRow glyph="✓" tone={T.dim} name="tester-2" note="1 fb" guide="├ " />
    <RailRow glyph="✓" tone={T.dim} name="tester-3" note="1 fb" guide="└ " />
  </box>
)
const Screen = (p: { at: Where; children: ReactNode; keys?: string }) => (
  <box style={{ flexDirection: "row", width: "100%", height: "100%", backgroundColor: T.bg }}>
    <Rail at={p.at} />
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>{p.children}</box>
      <text wrapMode="none" bg={T.raised}><span fg={T.accent}>{" › "}</span><span fg={T.faint}>message zarg… (alt+m or /)</span></text>
      <text wrapMode="none"><span fg={T.dim}>{" core · running · main"}</span><span fg={T.faint}>{`${" ".repeat(Math.max(1, 73 - (p.keys ?? "esc back").length))}${p.keys ?? "esc back"}`}</span></text>
    </box>
  </box>
)
const Title = (p: { name: string; sub: string; line2?: string }) => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <text wrapMode="none"><span fg={T.accent}><b>{p.name}</b></span><span fg={T.dim}>{`  ${p.sub}`}</span></text>
    {p.line2 !== undefined ? <text fg={T.dim} wrapMode="none">{p.line2}</text> : null}
    <text> </text>
  </box>
)
const Tabs = (p: { tabs: ReadonlyArray<[string, number]>; at: number }) => {
  const widths = p.tabs.map(([l, n]) => `${l} ${n}`.length)
  const before = widths.slice(0, p.at).reduce((a, w) => a + w + 3, 0)
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <text wrapMode="none">
        {p.tabs.map(([l, n], i) => <span key={l} fg={i === p.at ? T.accent : T.dim}>{i === p.at ? <b>{`${l} ${n}`}</b> : `${l} ${n}`}{i < p.tabs.length - 1 ? "   " : ""}</span>)}
        <span fg={T.faint}>{` ${"─".repeat(200)}`}</span>
      </text>
      <text fg={T.accent} wrapMode="none">{" ".repeat(before) + "▔".repeat(widths[p.at]!)}</text>
    </box>
  )
}
const Btn = (p: { label: string; k: string; primary?: boolean }) => (
  <>
    <span fg={p.primary ? T.accent : T.line}>{"▐"}</span>
    <span fg={p.primary ? T.bg : T.text} bg={p.primary ? T.accent : T.line}>{` ${p.label} `}</span>
    <span fg={p.primary ? T.raised : T.dim} bg={p.primary ? T.accent : T.line}>{` ${p.k} `}</span>
    <span fg={p.primary ? T.accent : T.line}>{"▌"}</span>
    <span>{"  "}</span>
  </>
)
const Search = (p: { hint: string; right?: string }) => (
  <text wrapMode="none" bg={T.raised}>
    <span fg={T.dim}>{" ⌕ "}</span>
    <span fg={T.faint}>{pad(p.hint, 52)}</span>
    <span fg={T.dim}>{pad(p.right ?? "", 32)}</span>
    <span fg={T.faint}>{"f"}</span>
  </text>
)
const Mark = (p: { on: boolean; picked: boolean }) => (
  <>
    <span fg={T.accent}>{p.on ? "▍" : " "}</span>
    <span fg={p.picked ? T.accent : T.dim}>{p.picked ? "● " : "○ "}</span>
  </>
)
const Gwt = (p: { g: string; w: string; t: string; changed?: boolean }) => (
  <>
    <text><span fg={T.accent}>{"Given "}</span><span fg={T.text}>{p.g}</span></text>
    <text><span fg={T.accent}>{"When  "}</span><span fg={T.text}>{p.w}</span></text>
    <text><span fg={T.accent}>{"Then  "}</span><span fg={T.text}>{p.t}</span></text>
  </>
)

// ── 1. Feedback: open, split list + detail, card checksum ─────────────────
const PICK = new Set(["F-1b0b", "F-09a2"])
const FeedbackOpen = () => {
  const f = FEEDBACK[2]!
  return (
    <>
      <Title name="Feedback" sub="from testers, per card version" line2="6 open · 2 stale · 3 in backlog · 1 dismissed" />
      <Tabs tabs={[["Open", 6], ["Stale", 2], ["In backlog", 3], ["Dismissed", 1]]} at={0} />
      <Search hint="search feedback: card, journey, persona, note…" right="sev ▾  persona ▾  journey ▾" />
      <text> </text>
      <box style={{ flexDirection: "row", flexShrink: 0 }}>
        <box style={{ width: 48, flexShrink: 0, flexDirection: "column" }}>
          <text fg={T.dim} wrapMode="none">{`   ${pad("card", 9)}${pad("persona", 13)}${pad("kind", 11)}${pad("sev", 7)}age`}</text>
          {FEEDBACK.map((x, i) => (
            <text key={x.id} wrapMode="none" {...(i === 2 ? { bg: T.sel } : {})}>
              <Mark on={i === 2} picked={PICK.has(x.id)} />
              <span fg={T.attn}>{pad(x.card, 9)}</span>
              <span fg={T.accent}>{pad(x.persona, 13)}</span>
              <span fg={T.text}>{pad(x.kind, 11)}</span>
              <span fg={sevTone(x.sev)}>{pad(x.sev, 7)}</span>
              <span fg={T.dim}>{x.age}</span>
            </text>
          ))}
        </box>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, border: ["left"], borderColor: T.line }}>
          <text wrapMode="none"><span fg={T.attn}>{f.card}</span><span fg={T.dim}>{" @"}</span><span fg={T.text}>{f.hash}</span><span fg={T.ok}>{"  ✓ card unchanged"}</span><span fg={T.faint}>{`  ${f.id}`}</span></text>
          <text fg={T.text}><b>Plugin asks for an optional scope</b></text>
          <text><span fg={T.dim}>{"by "}</span><span fg={T.accent}>{f.persona}</span><span fg={T.dim}>{" · in "}</span><span fg={T.ok}>{f.journey}</span><span fg={T.dim}>{` · ${f.from} · ${f.age} ago`}</span></text>
          <text><span fg={T.text}>{f.kind}</span><span fg={T.dim}>{" · "}</span><span fg={sevTone(f.sev)}>{f.sev}</span><span fg={T.dim}>{" · 2 on this card"}</span></text>
          <text> </text>
          {wrap(f.note, 42).map((l, i) => <text key={i} fg={T.text}>{l}</text>)}
          <text> </text>
          <Gwt g="the plugin runs" w="the plugin needs a scope it may ask for" t="the operator is asked: once, always, deny" />
        </box>
      </box>
      <text> </text>
      <text wrapMode="none"><Btn label="Send to backlog · 2" k="b" primary /><Btn label="Dismiss" k="d" /><span fg={T.dim}>{" Clear"}</span></text>
    </>
  )
}

// ── 2. Feedback: stale (the card changed since the tester saw it) ─────────
const FeedbackStale = () => {
  const f = STALE[0]!
  return (
    <>
      <Title name="Feedback" sub="from testers, per card version" line2="6 open · 2 stale · 3 in backlog · 1 dismissed" />
      <Tabs tabs={[["Open", 6], ["Stale", 2], ["In backlog", 3], ["Dismissed", 1]]} at={1} />
      <Search hint="search stale feedback…" />
      <text> </text>
      <box style={{ flexDirection: "row", flexShrink: 0 }}>
        <box style={{ width: 48, flexShrink: 0, flexDirection: "column" }}>
          <text fg={T.dim} wrapMode="none">{`   ${pad("card", 9)}${pad("seen → now", 15)}${pad("kind", 10)}${pad("sev", 6)}age`}</text>
          {STALE.map((x, i) => (
            <text key={x.id} wrapMode="none" {...(i === 0 ? { bg: T.sel } : {})}>
              <Mark on={i === 0} picked={false} />
              <span fg={T.attn}>{pad(x.card, 9)}</span>
              <span fg={T.dim}>{pad(`@${x.was} → @${x.now}`, 15)}</span>
              <span fg={T.dim}>{pad(x.kind, 10)}</span>
              <span fg={T.dim}>{pad(x.sev, 6)}</span>
              <span fg={T.dim}>{x.age}</span>
            </text>
          ))}
        </box>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, border: ["left"], borderColor: T.line }}>
          <text wrapMode="none"><span fg={T.attn}>{f.card}</span><span fg={T.dim}>{" @"}</span><span fg={T.dim}>{f.was}</span><span fg={T.attn}>{`  ⚠ card changed → @${f.now}`}</span></text>
          <text fg={T.text}><b>Operator rejects a plan</b></text>
          <text><span fg={T.dim}>{"by "}</span><span fg={T.accent}>{f.persona}</span><span fg={T.dim}>{" · in "}</span><span fg={T.ok}>{f.journey}</span><span fg={T.dim}>{` · ${f.from} · ${f.age} ago`}</span></text>
          <text> </text>
          {wrap(f.note, 42).map((l, i) => <text key={i} fg={T.dim}>{l}</text>)}
          <text> </text>
          <text fg={T.dim}>{"What changed since the tester saw it:"}</text>
          <text><span fg={T.accent}>{"When  "}</span><span fg={T.text}>{"the operator rejects the plan"}</span></text>
          <text><span fg={T.err}>{"- Then "}</span><span fg={T.dim}>{"the planner drafts again"}</span></text>
          <text><span fg={T.ok}>{"+ Then "}</span><span fg={T.text}>{"the operator is asked why, in one line"}</span></text>
          <text><span fg={T.ok}>{"+ Then "}</span><span fg={T.text}>{"the planner drafts again with that reason"}</span></text>
        </box>
      </box>
      <text> </text>
      <text wrapMode="none"><Btn label="Rehearse S-0041" k="r" primary /><Btn label="Still applies" k="k" /><Btn label="Drop" k="x" /></text>
    </>
  )
}

// ── 3. Rehearse: the run's rollup, no triage ──────────────────────────────
const Gauge = (p: { done: number; total: number; w: number }) => {
  const n = Math.round((p.done / p.total) * p.w)
  return <><span fg={T.accent}>{"━".repeat(n)}</span><span fg={T.faint}>{"━".repeat(p.w - n)}</span></>
}
const RehearseRun = () => (
  <>
    <Title name="rehearse" sub="run r-4f2a · 3 personas · 5 journeys" line2="done · 83/83 steps · 38 min" />
    <text wrapMode="none"><Gauge done={83} total={83} w={60} /><span fg={T.dim}>{"  83/83"}</span></text>
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>Testers</b></span><span fg={T.faint}>{` ${"─".repeat(200)}`}</span></text>
    <text fg={T.dim} wrapMode="none">{`  ${pad("tester", 11)}${pad("persona", 15)}${pad("journeys", 22)}${pad("steps", 9)}${pad("feedback", 10)}${pad("still open", 12)}likes`}</text>
    {[["tester-1", "Operator", "Set up, Reconcile", "41/41", "4", "4", "2"], ["tester-2", "CLI actor", "Sync code, Reconcile", "24/24", "1", "1", "0"], ["tester-3", "Driver Agent", "Set up", "18/18", "1", "1", "1"]].map((r, i) => (
      <text key={r[0]} wrapMode="none" {...(i === 0 ? { bg: T.sel } : {})}>
        <span fg={T.accent}>{i === 0 ? "▍ " : "  "}</span>
        <span fg={T.text}>{pad(r[0]!, 11)}</span>
        <span fg={T.accent}>{pad(r[1]!, 15)}</span>
        <span fg={T.ok}>{pad(r[2]!, 22)}</span>
        <span fg={T.dim}>{pad(r[3]!, 9)}</span>
        <span fg={T.attn}>{pad(r[4]!, 10)}</span>
        <span fg={T.text}>{pad(r[5]!, 12)}</span>
        <span fg={T.dim}>{r[6]}</span>
      </text>
    ))}
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>Feedback by journey</b></span><span fg={T.faint}>{` ${"─".repeat(200)}`}</span></text>
    {[["Set up", 4, "▇▇▇▇", "1 high · 2 medium · 1 low"], ["Reconcile", 2, "▇▇", "2 medium"], ["Sync code", 0, "", "clean"], ["Review", 0, "", "clean · 2 went stale since"], ["Agents", 0, "", "clean"]].map((r) => (
      <text key={r[0] as string} wrapMode="none">
        <span fg={T.ok}>{`  ${pad(r[0] as string, 12)}`}</span>
        <span fg={T.attn}>{pad(r[2] as string, 6)}</span>
        <span fg={T.text}>{pad(String(r[1]), 4)}</span>
        <span fg={T.dim}>{r[3] as string}</span>
      </text>
    ))}
    <text> </text>
    <text fg={T.dim} wrapMode="none">{"  Feedback lives in Feedback now; it outlives this run and goes stale when its card changes."}</text>
    <text> </text>
    <text wrapMode="none"><Btn label="Open in Feedback · 6" k="o" primary /><Btn label="Rehearse again" k="r" /></text>
  </>
)

// ── 4. Tester: its steps and what it found, read-only ─────────────────────
const TesterView = () => (
  <>
    <Title name="tester-1" sub="rehearse · Operator · Set up, Reconcile" line2="done · 41/41 steps · 4 feedback · 2 likes" />
    <text wrapMode="none"><span fg={T.accent}><b>Steps</b></span><span fg={T.faint}>{` ${"─".repeat(200)}`}</span></text>
    {[["S-0030", "Operator sets the driver key", "✓"], ["S-0035", "Operator picks a local model", "⚑ transition"], ["S-0059", "Operator starts a reconcile pass", "⚑ feature"], ["S-0062", "Plugin asks for an optional scope", "⚑ friction, gap"], ["S-0063", "Operator approves the scope once", "✓"]].map((r) => (
      <text key={r[0]} wrapMode="none"><span fg={T.attn}>{`  ${pad(r[0]!, 9)}`}</span><span fg={T.text}>{pad(r[1]!, 38)}</span><span fg={r[2]!.startsWith("⚑") ? T.attn : T.ok}>{r[2]}</span></text>
    ))}
    <text> </text>
    <Tabs tabs={[["Feedback", 4], ["Likes", 2]]} at={0} />
    <text fg={T.dim} wrapMode="none">{`  ${pad("card", 9)}${pad("kind", 11)}${pad("sev", 8)}${pad("now", 18)}note`}</text>
    {FEEDBACK.filter((f) => f.from === "tester-1").map((f, i) => {
      const now = f.id === "F-1b0b" ? ["in backlog B-12", T.accent] : f.id === "F-1e10" ? ["open", T.text] : f.id === "F-09a2" ? ["in backlog B-12", T.accent] : ["open", T.text]
      return (
        <text key={f.id} wrapMode="none" {...(i === 0 ? { bg: T.sel } : {})}>
          <span fg={T.accent}>{i === 0 ? "▍ " : "  "}</span>
          <span fg={T.attn}>{pad(f.card, 9)}</span>
          <span fg={T.text}>{pad(f.kind, 11)}</span>
          <span fg={sevTone(f.sev)}>{pad(f.sev, 8)}</span>
          <span fg={now[1]}>{pad(now[0]!, 18)}</span>
          <span fg={T.dim}>{pad(f.note, 42)}</span>
        </text>
      )
    })}
    <text> </text>
    <text wrapMode="none"><Btn label="Open in Feedback" k="o" primary /></text>
  </>
)

// ── 5. Backlog: kanban (Hermes-style columns, cards, toolbar) ─────────────
type Item = { id: string; title: string; card: string; persona: string; sev: string; fb: number; who?: string; stale?: boolean; blocked?: string; age: string; picked?: boolean }
const COLS: ReadonlyArray<[string, ReadonlyArray<Item>]> = [
  ["Backlog", [
    { id: "B-12", title: "Grant prompt names its choices and a deny path", card: "S-0062", persona: "Operator", sev: "medium", fb: 2, age: "1m" },
    { id: "B-11", title: "Say which role lacks a key", card: "S-0030", persona: "Driver Agent", sev: "high", fb: 1, age: "2h" },
    { id: "B-09", title: "Ask why a plan is rejected", card: "S-0041", persona: "Operator", sev: "high", fb: 1, stale: true, age: "2d" },
  ]],
  ["Ready", [
    { id: "B-08", title: "Pass or fail from the tester, not prose", card: "S-0056", persona: "CLI actor", sev: "medium", fb: 1, age: "5h" },
    { id: "B-10", title: "Show the model is local", card: "S-0035", persona: "Operator", sev: "low", fb: 1, blocked: "B-08", age: "1d" },
  ]],
  ["Running", [{ id: "B-07", title: "Scaffold missing plan and implement models", card: "S-0059", persona: "Operator", sev: "medium", fb: 1, who: "Implementer", age: "20m" }]],
  ["Review", [{ id: "B-05", title: "Archive finished agents after a day", card: "S-0071", persona: "Operator", sev: "low", fb: 2, who: "Implementer", age: "1h" }]],
  ["Done", [
    { id: "B-04", title: "Search findings", card: "S-0080", persona: "Operator", sev: "low", fb: 1, age: "1d" },
    { id: "B-02", title: "Buttons in views", card: "S-0077", persona: "Operator", sev: "medium", fb: 3, age: "2d" },
  ]],
]
const CW = 17
const Card = (p: { it: Item; on: boolean }) => (
  <box style={{ flexDirection: "column", flexShrink: 0, backgroundColor: p.on ? T.sel : T.raised, marginBottom: 1 }}>
    <text wrapMode="none">
      <span fg={T.accent}>{p.on ? "▍" : " "}</span>
      <span fg={T.faint}>{pad(p.it.id, 6)}</span>
      <span fg={sevTone(p.it.sev)}>{pad(`● ${p.it.sev}`, CW - 7)}</span>
    </text>
    {wrap(p.it.title, CW - 2, 2).map((l, i) => <text key={i} wrapMode="none" fg={T.text}>{` ${pad(l, CW - 1)}`}</text>)}
    <text wrapMode="none"><span fg={T.attn}>{` ${p.it.card}`}</span><span fg={T.accent}>{pad(` ${p.it.persona === "Operator" ? "Op" : p.it.persona === "CLI actor" ? "CLI" : "Drv"}`, CW - 8)}</span></text>
    {p.it.who !== undefined ? <text wrapMode="none"><span fg={T.accent}>{" ⠼ "}</span><span fg={T.text}>{pad(p.it.who, CW - 3)}</span></text> : null}
    {p.it.stale === true ? <text wrapMode="none" fg={T.attn}>{pad(" ⚠ card changed", CW)}</text> : null}
    {p.it.blocked !== undefined ? <text wrapMode="none" fg={T.err}>{pad(` ⇠ ${p.it.blocked}`, CW)}</text> : null}
    <text wrapMode="none" fg={T.dim}>{pad(` ◇${p.it.fb}  ◷ ${p.it.age}`, CW)}</text>
  </box>
)
const Board = (p: { drawer?: boolean }) => (
  <>
    <Title name="Backlog" sub="work from feedback and the graph" />
    <text wrapMode="none" bg={T.raised}>
      <span fg={T.dim}>{" ⌕ "}</span><span fg={T.faint}>{pad("search items…", 30)}</span>
      <span fg={T.dim}>{"journey ▾  persona ▾  agent ▾  "}</span><span fg={T.faint}>{"☐ done  ☐ lanes by agent "}</span>
    </text>
    <text> </text>
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      {COLS.map(([name, items], ci) => (
        <box key={name} style={{ width: CW, marginRight: 2, flexDirection: "column", flexShrink: 0 }}>
          <text wrapMode="none"><span fg={ci === 0 ? T.accent : T.text}><b>{name}</b></span><span fg={T.dim}>{` ${items.length}`}</span></text>
          <text fg={ci === 0 ? T.accent : T.faint} wrapMode="none">{(ci === 0 ? "▔" : "─").repeat(CW)}</text>
          {items.map((it, i) => <CardA key={it.id} it={it} on={ci === 0 && i === 0} w={CW} />)}
        </box>
      ))}
    </box>
    {p.drawer === true ? <Drawer /> : null}
  </>
)
const Drawer = () => (
  <box style={{ position: "absolute", right: 0, top: 0, width: 50, height: "100%", flexDirection: "column", backgroundColor: T.shade, border: ["left"], borderColor: T.accent, paddingLeft: 2, paddingRight: 1, paddingTop: 1 }}>
    <text wrapMode="none"><span fg={T.faint}>{"B-12  "}</span><span fg={T.dim}>{"Backlog"}</span><span fg={T.faint}>{" ".repeat(33) + "×"}</span></text>
    <text fg={T.text}><b>Grant prompt names its choices and a deny path</b></text>
    <text wrapMode="none"><span fg={T.attn}>{"S-0062"}</span><span fg={T.dim}>{" @3f9a "}</span><span fg={T.ok}>{"✓"}</span><span fg={T.dim}>{" · "}</span><span fg={T.accent}>{"Operator"}</span><span fg={T.dim}>{" · "}</span><span fg={T.ok}>{"Set up"}</span><span fg={T.dim}>{" · "}</span><span fg={T.attn}>{"medium"}</span></text>
    <text> </text>
    <text wrapMode="none"><Btn label="→ Ready" k="⏎" primary /><Btn label="Assign" k="a" /><Btn label="Drop" k="x" /></text>
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>Feedback 2</b></span><span fg={T.faint}>{` ${"─".repeat(40)}`}</span></text>
    {["friction  The grant question names scope and target but not the choice set.", "gap       No failure path when the operator denies, ignores, or defers."].map((l, i) => (
      <text key={i} wrapMode="none"><span fg={T.attn}>{" ◇ "}</span><span fg={T.dim}>{pad(l, 42)}</span></text>
    ))}
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>Card</b></span><span fg={T.faint}>{` ${"─".repeat(40)}`}</span></text>
    <Gwt g="the plugin runs" w="the plugin needs a scope it may ask for" t="the operator is asked: once, always, deny" />
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>Links</b></span><span fg={T.faint}>{` ${"─".repeat(40)}`}</span></text>
    <text wrapMode="none"><span fg={T.dim}>{" blocks  "}</span><span fg={T.text}>{"B-10"}</span><span fg={T.dim}>{"   after  "}</span><span fg={T.faint}>{"+ add"}</span></text>
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>Events</b></span><span fg={T.faint}>{` ${"─".repeat(40)}`}</span></text>
    <text fg={T.dim} wrapMode="none">{" from feedback F-1b0b, F-09a2 (tester-1)"}</text>
    <text fg={T.dim} wrapMode="none">{" created by Operator"}</text>
  </box>
)


// ── Card variants (no time) ───────────────────────────────────────────────
const persona = (p: string) => p
const Stripe = (p: { tone: string }) => <span fg={p.tone}>{"▌"}</span>
/** A: a severity stripe; id and feedback count on top; the whole title; the card, then who. */
const CardA = (p: { it: Item; on: boolean; w: number }) => {
  const bg = p.on ? T.sel : T.raised
  const st = sevTone(p.it.sev)
  const row = (k: string | number, body: ReactNode) => <text key={k} wrapMode="none" bg={bg}><Stripe tone={st} />{body}</text>
  const iw = p.w - 1
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
      {row("h", <><span fg={T.faint}>{`${p.it.id} `}</span><span fg={T.attn}>{pad(p.it.card, iw - p.it.id.length - 4)}</span><span fg={T.dim}>{`◇${p.it.fb} `}</span></>)}
      {wrap(p.it.title, iw - 1).map((l, i) => row(i, <span fg={T.text}>{p.on ? <b>{pad(l, iw)}</b> : pad(l, iw)}</span>))}
      {row("c", <span fg={T.accent}>{pad(persona(p.it.persona), iw)}</span>)}
      {p.it.who !== undefined ? row("w", <><span fg={T.accent}>{"⠼ "}</span><span fg={T.text}>{pad(p.it.who, iw - 2)}</span></>) : null}
      {p.it.stale === true ? row("s", <span fg={T.attn}>{pad("⚠ card changed", iw)}</span>) : null}
      {p.it.blocked !== undefined ? row("b", <span fg={T.err}>{pad(`⇠ after ${p.it.blocked}`, iw)}</span>) : null}
    </box>
  )
}
/** C: title first, a quiet meta line under it; severity colours the id; no fill, a rule between cards. */
const CardC = (p: { it: Item; on: boolean; w: number }) => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    {wrap(p.it.title, p.w - 2).map((l, i) => (
      <text key={i} wrapMode="none" {...(p.on ? { bg: T.sel } : {})}><span fg={T.accent}>{p.on && i === 0 ? "▍" : " "}</span><span fg={T.text}><b>{pad(l, p.w - 1)}</b></span></text>
    ))}
    <text wrapMode="none" {...(p.on ? { bg: T.sel } : {})}><span>{" "}</span><span fg={sevTone(p.it.sev)}>{`${p.it.id} `}</span><span fg={T.attn}>{`${p.it.card} `}</span><span fg={T.dim}>{pad(`◇${p.it.fb}`, p.w - 1 - p.it.id.length - p.it.card.length - 2)}</span></text>
    <text wrapMode="none" {...(p.on ? { bg: T.sel } : {})}><span>{" "}</span><span fg={T.accent}>{pad(p.it.persona, p.w - 1)}</span></text>
    {p.it.who !== undefined ? <text wrapMode="none"><span fg={T.accent}>{" ⠼ "}</span><span fg={T.text}>{p.it.who}</span></text> : null}
    {p.it.stale === true ? <text wrapMode="none" fg={T.attn}>{" ⚠ card changed"}</text> : null}
    {p.it.blocked !== undefined ? <text wrapMode="none" fg={T.err}>{` ⇠ after ${p.it.blocked}`}</text> : null}
    <text fg={T.faint} wrapMode="none">{" " + "╌".repeat(p.w - 2)}</text>
  </box>
)
const Toolbar = () => (
  <text wrapMode="none" bg={T.raised}>
    <span fg={T.dim}>{" ⌕ "}</span><span fg={T.faint}>{pad("search items…", 30)}</span>
    <span fg={T.dim}>{"journey ▾  persona ▾  agent ▾  "}</span><span fg={T.faint}>{"☐ done  ☐ lanes by agent "}</span>
  </text>
)
const BoardV = (p: { card: "A" | "C"; cols?: number; w: number }) => {
  const shown = COLS.slice(0, p.cols ?? 5)
  const rest = COLS.slice(p.cols ?? 5)
  const C = p.card === "A" ? CardA : CardC
  return (
    <>
      <Title name="Backlog" sub="work from feedback and the graph" />
      <Toolbar />
      <text> </text>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        {shown.map(([name, items], ci) => (
          <box key={name} style={{ width: p.w, marginRight: 2, flexDirection: "column", flexShrink: 0 }}>
            <text wrapMode="none"><span fg={ci === 0 ? T.accent : T.text}><b>{name}</b></span><span fg={T.dim}>{` ${items.length}`}</span></text>
            <text fg={ci === 0 ? T.accent : T.faint} wrapMode="none">{(ci === 0 ? "▔" : "─").repeat(p.w)}</text>
            {items.map((it, i) => <C key={it.id} it={it} on={ci === 0 && i === 0} w={p.w} />)}
          </box>
        ))}
        {rest.map(([name, items]) => (
          <box key={name} style={{ width: 8, flexDirection: "column", flexShrink: 0 }}>
            <text wrapMode="none"><span fg={T.dim}><b>{name}</b></span><span fg={T.dim}>{` ${items.length}`}</span></text>
            <text fg={T.faint} wrapMode="none">{"─".repeat(8)}</text>
            {items.map((it) => <text key={it.id} fg={T.faint} wrapMode="none">{`✓ ${it.id}`}</text>)}
            <text fg={T.faint} wrapMode="none">{"   ›"}</text>
          </box>
        ))}
      </box>
    </>
  )
}


// ── D: lanes scroll on their own and fold to a vertical strip ─────────────
const MORE: ReadonlyArray<Item> = [
  { id: "B-13", title: "Explain what 'defer' means in a grant", card: "S-0062", persona: "Operator", sev: "low", fb: 1 },
  { id: "B-14", title: "Tester answers pass or fail per step", card: "S-0056", persona: "CLI actor", sev: "medium", fb: 1 },
  { id: "B-15", title: "Show which journeys a card is in", card: "S-0044", persona: "Operator", sev: "low", fb: 1 },
] as never
const LANE_H = 21
const Scrollbar = (p: { h: number; top: number; size: number }) => (
  <box style={{ width: 1, flexDirection: "column", flexShrink: 0 }}>
    {Array.from({ length: p.h }, (_, i) => <text key={i} fg={i >= p.top && i < p.top + p.size ? T.accent : T.line}>{i >= p.top && i < p.top + p.size ? "┃" : "│"}</text>)}
  </box>
)
const Folded = (p: { name: string; n: number; on?: boolean }) => (
  <box style={{ width: 3, height: LANE_H + 2, marginRight: 1, flexDirection: "column", flexShrink: 0, backgroundColor: p.on ? T.sel : T.raised, alignItems: "center" }}>
    <text fg={T.dim}>{String(p.n)}</text>
    <text fg={T.faint}>{"▸"}</text>
    {p.name.toUpperCase().split("").map((c, i) => <text key={i} fg={p.on ? T.accent : T.text}><b>{c}</b></text>)}
  </box>
)
const Lane = (p: { name: string; items: ReadonlyArray<Item>; w: number; focus?: boolean; cursor?: number; skip?: number; scroll?: { top: number; size: number } }) => (
  <box style={{ width: p.w, marginRight: 2, flexDirection: "column", flexShrink: 0 }}>
    <text wrapMode="none"><span fg={p.focus ? T.accent : T.text}><b>{p.name}</b></span><span fg={T.dim}>{pad(` ${p.items.length}`, p.w - p.name.length - 2)}</span><span fg={T.faint}>{"◂"}</span></text>
    <text fg={p.focus ? T.accent : T.faint} wrapMode="none">{(p.focus ? "▔" : "─").repeat(p.w)}</text>
    <box style={{ flexDirection: "row", height: LANE_H }}>
      <box style={{ flexDirection: "column", width: p.w - 2, overflow: "hidden" }}>
        {p.items.slice(p.skip ?? 0).map((it, i) => <CardA key={it.id} it={it} on={p.cursor === i + (p.skip ?? 0)} w={p.w - 2} />)}
      </box>
      <box style={{ width: 1 }} />
      {p.scroll !== undefined ? <Scrollbar h={LANE_H} top={p.scroll.top} size={p.scroll.size} /> : null}
    </box>
  </box>
)
const BoardD = (p: { mode: "some" | "one" }) => {
  const backlog = [...COLS[0]![1], ...MORE]
  return (
    <>
      <Title name="Backlog" sub="work from feedback and the graph" />
      <Toolbar />
      <text> </text>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        {p.mode === "some" ? (
          <>
            <Lane name="Backlog" items={backlog} w={26} focus cursor={0} scroll={{ top: 0, size: 12 }} />
            <Lane name="Ready" items={COLS[1]![1]} w={26} />
            <Lane name="Running" items={COLS[2]![1]} w={24} />
            <Folded name="Review" n={1} />
            <Folded name="Done" n={2} />
          </>
        ) : (
          <>
            <Lane name="Backlog" items={backlog} w={58} focus cursor={4} skip={2} scroll={{ top: 7, size: 14 }} />
            <Folded name="Ready" n={2} />
            <Folded name="Running" n={1} on />
            <Folded name="Review" n={1} />
            <Folded name="Done" n={2} />
          </>
        )}
      </box>
    </>
  )
}


// ── Triage hub: Feedback is where the Triage Agent refines, re-rehearses and plans ──
const STAGES = ["Triage", "Refine", "Re-rehearse", "Plan"] as const
const Stepper = (p: { at: number }) => (
  <text wrapMode="none">
    {STAGES.map((st, i) => (
      <span key={st} fg={i < p.at ? T.ok : i === p.at ? T.accent : T.faint}>{i < p.at ? `✓ ${st}` : i === p.at ? `● ${st}` : `○ ${st}`}{i < STAGES.length - 1 ? <span fg={T.faint}>{"  ───  "}</span> : ""}</span>
    ))}
  </text>
)
const JOURNEYS = [
  { name: "Set up", open: 4, stage: 1, note: "refining 2 of 3 cards" },
  { name: "Reconcile", open: 2, stage: 0, note: "waits for the agent" },
  { name: "Review", open: 0, stage: 3, note: "planned → B-09" },
  { name: "Sync code", open: 0, stage: -1, note: "clean" },
  { name: "Agents", open: 0, stage: -1, note: "clean" },
]
const stageGlyph = (st: number) => (st < 0 ? ["·", T.faint] : st === 3 ? ["✓", T.ok] : st === 0 ? ["○", T.dim] : ["⠼", T.accent]) as [string, string]
const JourneyList = (p: { at: number; stage: number }) => (
  <box style={{ width: 34, flexShrink: 0, flexDirection: "column" }}>
    <text fg={T.dim} wrapMode="none">{`   ${pad("journey", 12)}${pad("open", 5)}stage`}</text>
    {JOURNEYS.map((j0, i) => {
      const j = i === 0 ? { ...j0, stage: p.stage, open: p.stage === 3 ? 0 : 4, note: ["4 on · 1 off", "refining 2 of 3 cards", "re-rehearsing 9/14", "plan ready"][p.stage]! } : j0
      const [g, tone] = stageGlyph(i === 0 && p.stage < 3 ? Math.max(1, p.stage) : j.stage)
      return (
        <box key={j.name} style={{ flexDirection: "column", flexShrink: 0, ...(i === p.at ? { backgroundColor: T.sel } : {}) }}>
          <text wrapMode="none"><span fg={T.accent}>{i === p.at ? "▍" : " "}</span><span fg={tone}>{`${g} `}</span><span fg={T.ok}>{pad(j.name, 12)}</span><span fg={j.open > 0 ? T.attn : T.faint}>{pad(String(j.open), 5)}</span><span fg={T.dim}>{pad(j.stage < 0 ? "" : STAGES[j.stage]!, 11)}</span></text>
          <text wrapMode="none" fg={T.faint}>{`   ${pad(j.note, 26)}`}</text>
        </box>
      )
    })}
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}>{" ⠼ "}</span><span fg={T.text}>{"Triage Agent"}</span></text>
    <text wrapMode="none" fg={T.dim}>{`   on Set up · ${STAGES[p.stage]}`}</text>
  </box>
)
const Side = (p: { children: ReactNode }) => (
  <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, border: ["left"], borderColor: T.line }}>{p.children}</box>
)
const Hub = (p: { stage: number; children: ReactNode; buttons: ReactNode }) => (
  <>
    <Title name="Feedback" sub="triage: feedback is refined into the graph, re-rehearsed, then planned" />
    <Stepper at={p.stage} />
    <text> </text>
    <box style={{ flexDirection: "row", flexShrink: 0 }}>
      <JourneyList at={0} stage={p.stage} />
      <Side>{p.children}</Side>
    </box>
    <text> </text>
    <text wrapMode="none">{p.buttons}</text>
  </>
)
const H = (p: { t: string; right?: string }) => <text wrapMode="none"><span fg={T.accent}><b>{p.t}</b></span>{p.right !== undefined ? <span fg={T.dim}>{`  ${p.right}`}</span> : null}<span fg={T.faint}>{` ${"─".repeat(80)}`}</span></text>

/* Triage stage */

/** 0. Triage: each feedback entry on or off; the Triage Agent sets them first, with a reason; you flip any. */
const TRI = [
  { card: "S-0030", kind: "gap", sev: "high", note: "which role needs the key?", on: true, why: "three roles, one prompt", you: false },
  { card: "S-0062", kind: "friction", sev: "medium", note: "no choice set named", on: true, why: "'later' is undefined", you: false },
  { card: "S-0062", kind: "gap", sev: "medium", note: "no path when denied or deferred", on: true, why: "the card has no deny case", you: false },
  { card: "S-0035", kind: "transition", sev: "low", note: "doesn't say the model is local", on: false, why: "already said on S-0034", you: false },
  { card: "S-0031", kind: "feature", sev: "low", note: "a key strength meter", on: true, why: "out of scope", you: true },
]
const Toggle = (p: { on: boolean }) => (p.on ? <span fg={T.ok}>{"[●] "}</span> : <span fg={T.faint}>{"[ ] "}</span>)
const HubTriage = () => (
  <Hub stage={0} buttons={<><Btn label="Refine 4 on" k="r" primary /><Btn label="Flip" k="space" /><span fg={T.dim}>{" off entries stay, dimmed, for this card version"}</span></>}>
    <H t="Set up" right="5 feedback · the agent's call, yours to flip" />
    {TRI.map((t, i) => (
      <box key={i} style={{ flexDirection: "column", flexShrink: 0, ...(i === 3 ? { backgroundColor: T.sel } : {}) }}>
        <text wrapMode="none">
          <span fg={T.accent}>{i === 3 ? "▍" : " "}</span>
          <Toggle on={t.on} />
          <span fg={t.on ? T.attn : T.faint}>{pad(t.card, 9)}</span>
          <span fg={t.on ? sevTone(t.sev) : T.faint}>{pad(t.sev, 8)}</span>
          <span fg={t.on ? T.text : T.faint}>{pad(t.note, 36)}</span>
        </text>
        <text wrapMode="none"><span fg={T.accent}>{i === 3 ? "▍" : " "}</span><span>{"     "}</span><span fg={T.faint}>{pad(t.kind, 11)}</span><span fg={t.you ? T.accent : T.dim}>{t.you ? "you: on · agent: off · out of scope" : `agent: ${t.on ? "on" : "off"} · ${t.why}`}</span></text>
      </box>
    ))}
  </Hub>
)

/** 1. Feedback: the journey's open feedback, grouped by card. */
const HubFeedback = () => (
  <Hub stage={0} buttons={<><Btn label="Triage Set up" k="t" primary /><Btn label="Dismiss" k="d" /><span fg={T.dim}>{" 4 open · 0 stale"}</span></>}>
    <H t="Set up" right="4 open on 3 cards" />
    {[["S-0030", "@a41e", "Operator sets the driver key", [["gap", "high", "which role needs the key?"]]], ["S-0062", "@3f9a", "Plugin asks for an optional scope", [["friction", "medium", "no choice set named"], ["gap", "medium", "no path when denied or deferred"]]], ["S-0035", "@5d13", "Operator picks a local model", [["transition", "low", "doesn't say the model is local"]]]].map(([card, h, title, fb], ci) => (
      <box key={card as string} style={{ flexDirection: "column", flexShrink: 0 }}>
        <text wrapMode="none"><span fg={T.attn}>{card as string}</span><span fg={T.faint}>{` ${h}  `}</span><span fg={T.text}>{title as string}</span></text>
        {(fb as Array<Array<string>>).map((f, i) => (
          <text key={i} wrapMode="none" {...(ci === 1 && i === 0 ? { bg: T.sel } : {})}><span fg={T.accent}>{ci === 1 && i === 0 ? "▍" : " "}</span><span fg={T.dim}>{" ◇ "}</span><span fg={T.text}>{pad(f[0]!, 11)}</span><span fg={sevTone(f[1]!)}>{pad(f[1]!, 8)}</span><span fg={T.dim}>{pad(f[2]!, 38)}</span></text>
        ))}
        <text> </text>
      </box>
    ))}
  </Hub>
)
/** 2. Refine: the Triage Agent proposes a card change for the feedback; the operator accepts, revises or skips. */
const HubRefine = () => (
  <Hub stage={1} buttons={<><Btn label="Accept" k="a" primary /><Btn label="Revise…" k="e" /><Btn label="Skip card" k="s" /><span fg={T.dim}>{" 2 of 3 cards"}</span></>}>
    <H t="S-0062" right="Plugin asks for an optional scope" />
    <text fg={T.dim} wrapMode="none">{"Triage Agent proposes:"}</text>
    <text><span fg={T.accent}>{"  When  "}</span><span fg={T.text}>{"the plugin needs a scope it may ask for"}</span></text>
    <text><span fg={T.err}>{"- Then  "}</span><span fg={T.dim}>{"the operator is asked: once, always, deny"}</span></text>
    <text><span fg={T.ok}>{"+ Then  "}</span><span fg={T.text}>{"the operator sees: once, always, deny"}</span></text>
    <text> </text>
    <text wrapMode="none"><span fg={T.ok}>{"+ card  "}</span><span fg={T.attn}>{"new "}</span><span fg={T.text}>{"Operator denies the scope"}</span></text>
    <text><span fg={T.accent}>{"  When  "}</span><span fg={T.text}>{"the operator denies the scope"}</span></text>
    <text><span fg={T.ok}>{"+ Then  "}</span><span fg={T.text}>{"the plugin goes on without it and says so"}</span></text>
    <text> </text>
    <text wrapMode="none"><span fg={T.dim}>{"answers  "}</span><span fg={T.ok}>{"✓ "}</span><span fg={T.text}>{"friction: no choice set named"}</span></text>
    <text wrapMode="none"><span fg={T.dim}>{"         "}</span><span fg={T.ok}>{"✓ "}</span><span fg={T.text}>{"gap: no path when denied"}</span></text>
  </Hub>
)
/** 3. Re-rehearse: a tester walks the whole journey on the refined cards; old feedback closes or stays. */
const HubRehearse = () => (
  <Hub stage={2} buttons={<><Btn label="Stop" k="x" /><span fg={T.dim}>{" the Triage Agent plans when the journey is clean"}</span></>}>
    <H t="Set up" right="re-rehearsing the journey" />
    <text wrapMode="none"><Gauge done={9} total={14} w={40} /><span fg={T.dim}>{"  9/14"}</span></text>
    <text> </text>
    {[["S-0030", "Operator sets the driver key", "✓ resolved", T.ok], ["S-0035", "Operator picks a local model", "✓ resolved", T.ok], ["S-0062", "Plugin asks for an optional scope", "✓ resolved ×2", T.ok], ["S-0090", "Operator denies the scope", "◇ new · low", T.attn], ["S-0063", "Operator approves the scope once", "⠼ testing", T.accent], ["S-0064", "Operator approves the scope always", "○", T.faint]].map((r) => (
      <text key={r[0]} wrapMode="none"><span fg={T.attn}>{pad(r[0]!, 9)}</span><span fg={T.text}>{pad(r[1]!, 34)}</span><span fg={r[3]}>{r[2]}</span></text>
    ))}
  </Hub>
)
/** 4. Plan: the Triage Agent backlogs one plan for the journey's refined cards. */
const HubPlan = () => (
  <Hub stage={3} buttons={<><Btn label="Backlog plan" k="b" primary /><Btn label="Refine more" k="r" /><span fg={T.dim}>{" or leave it: the Triage Agent backlogs it"}</span></>}>
    <H t="Plan" right="Set up · drafted by the Triage Agent" />
    <text fg={T.text}><b>Grant prompt names its choices and a deny path</b></text>
    <text wrapMode="none"><span fg={T.dim}>{"cards  "}</span><span fg={T.attn}>{"S-0030  S-0035  S-0062  "}</span><span fg={T.ok}>{"+S-0090"}</span></text>
    <text wrapMode="none"><span fg={T.dim}>{"closes "}</span><span fg={T.text}>{"◇ 4 feedback · journey re-rehearsed clean"}</span></text>
    <text> </text>
    {["1. Name the missing role in the key prompt (S-0030).", "2. Say 'local' beside a local model (S-0035).", "3. Grant popover: once, always, deny (S-0062).", "4. Deny path: the plugin goes on and says so (S-0090)."].map((l, i) => <text key={i} fg={T.text}>{l}</text>)}
    <text> </text>
    <text wrapMode="none"><span fg={T.dim}>{"goes to  "}</span><span fg={T.text}>{"Backlog · Ready"}</span><span fg={T.dim}>{" → the Planner Agent picks it up"}</span></text>
  </Hub>
)

// ── render ────────────────────────────────────────────────────────────────
const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const out: Record<string, string> = {}
const frames: ReadonlyArray<[string, ReactNode]> = [
  ["t0", <Screen at="feedback" keys="space flip · r refine · esc back"><HubTriage /></Screen>],
  ["t2", <Screen at="feedback" keys="a accept · e revise · s skip · esc back"><HubRefine /></Screen>],
  ["t3", <Screen at="feedback" keys="x stop · esc back"><HubRehearse /></Screen>],
  ["t4", <Screen at="feedback" keys="b backlog · r refine · esc back"><HubPlan /></Screen>],
  ["kD1", <Screen at="backlog" keys="←→ lane · ↑↓ item · z fold · ⇧←→ move · ⏎ open"><BoardD mode="some" /></Screen>],
  ["kD2", <Screen at="backlog" keys="←→ lane · ↑↓ item · z fold · Z fold others · ⏎ open"><BoardD mode="one" /></Screen>],
  ["kA", <Screen at="backlog" keys="←→ column · ↑↓ item · ⇧←→ move · ⏎ open"><BoardV card="A" w={17} /></Screen>],
  ["kB", <Screen at="backlog" keys="←→ column · ↑↓ item · ⇧←→ move · ⏎ open"><BoardV card="A" cols={4} w={19} /></Screen>],
  ["kC", <Screen at="backlog" keys="←→ column · ↑↓ item · ⇧←→ move · ⏎ open"><BoardV card="C" cols={4} w={19} /></Screen>],
  ["drawer", <Screen at="backlog" keys="⏎ ready · a assign · x drop · esc close"><Board drawer /></Screen>],
]
for (const [k, node] of frames) {
  const t = await testRender(node, { width: 120, height: 32, exitOnCtrlC: false, exitSignals: [] })
  await t.renderOnce()
  out[k] = t.captureSpans().lines.map((l) => l.spans.map((sp) => `<span style="color:${hex(sp.fg)};background:${hex(sp.bg)}${sp.attributes & 1 ? ";font-weight:700" : ""}">${esc(sp.text)}</span>`).join("")).join("\n")
  if (!process.argv.includes("--html")) console.log(`\n── ${k} ──\n${t.captureCharFrame()}`)
  t.renderer.destroy()
}
if (process.argv.includes("--html")) await Bun.write(process.argv.at(-1)!, JSON.stringify(out))
