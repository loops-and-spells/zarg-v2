// THROWAWAY MOCKUP (never commit): a richer triage hub (the Feedback view), its live agent strip, and the Triage Agent's own view.
import { testRender } from "@opentui/react/test-utils"
import type { ReactNode } from "react"

const T = { bg: "#0f1115", raised: "#161a21", line: "#262b35", text: "#d7dce2", dim: "#6b7280", faint: "#3b4150", accent: "#7aa2f7", attn: "#e0af68", ok: "#9ece6a", err: "#f7768e", sel: "#1f2533", shade: "#1a1f28", add: "#9ece6a", del: "#f7768e", journey: "#bb9af7", card: "#7dcfff" }
const W = 120
const RW = 24
const FW = W - RW - 1
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s + " ".repeat(Math.max(0, n - s.length)))
const wrap = (t: string, w: number, max = 99) => {
  const lines: Array<string> = [""]
  for (const word of t.split(" ")) {
    const next = `${lines.at(-1)!} ${word}`.trim()
    if (next.length <= w) lines[lines.length - 1] = next
    else if (lines.length === max) {
      lines[lines.length - 1] = `${lines.at(-1)!.slice(0, w - 1)}…`
      return lines
    } else lines.push(word)
  }
  return lines
}
const sevTone = (s: string) => (s === "high" ? T.err : s === "medium" ? T.attn : T.dim)
const sevGlyph = (s: string) => (s === "high" ? "▲" : s === "medium" ? "■" : "·")

// ── Shell: the rail with Feedback and the Triage Agent ─────────────────────
const Band = (p: { label: string; count: string }) => (
  <text wrapMode="none" bg={T.line}>
    <span fg={T.text}><b>{` ${p.label}`}</b></span>
    <span>{" ".repeat(RW - 3 - p.label.length - p.count.length)}</span>
    <span fg={T.dim}>{`${p.count} `}</span>
  </text>
)
const RailRow = (p: { glyph: string; tone: string; name: string; note: string; on?: boolean; noteTone?: string; guide?: string }) => {
  const g = p.guide ?? ""
  const room = RW - 7 - g.length - p.note.length
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
type Where = "feedback" | "agent" | "backlog"
const Rail = (p: { at: Where; busy?: string }) => (
  <box style={{ width: RW, flexShrink: 0, flexDirection: "column", backgroundColor: T.raised, border: ["right"], borderColor: T.line }}>
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}>{" ◆ "}</span><span fg={T.text}><b>zarg</b></span></text>
    <text fg={T.dim} wrapMode="none">{"   zarg-v2 · master"}</text>
    <text> </text>
    <Band label="VIEWS" count="3" />
    <RailRow glyph="◇" tone={T.journey} name="Journeys" note="5" />
    <RailRow glyph="◇" tone={T.attn} name="Feedback" note="68·7" noteTone={T.attn} on={p.at === "feedback"} />
    <RailRow glyph="▦" tone={T.accent} name="Backlog" note="2" on={p.at === "backlog"} />
    <text> </text>
    <Band label="AGENTS" count="2" />
    <RailRow glyph={p.busy !== undefined ? "⠹" : "●"} tone={T.accent} name="Triage Agent" note={p.busy ?? "idle"} noteTone={T.accent} on={p.at === "agent"} />
    <RailRow glyph="●" tone={T.ok} name="rehearse" note="3/6" guide="" />
    <RailRow glyph="○" tone={T.dim} name="tester-1" note="Operator" guide="├ " />
    <RailRow glyph="○" tone={T.dim} name="tester-2" note="Driver" guide="└ " />
  </box>
)
const Screen = (p: { at: Where; children: ReactNode; keys: string; busy?: string }) => (
  <box style={{ flexDirection: "row", width: W, height: 32, backgroundColor: T.bg }}>
    <Rail at={p.at} {...(p.busy !== undefined ? { busy: p.busy } : {})} />
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, paddingRight: 2 }}>{p.children}</box>
      <text wrapMode="none" bg={T.raised}><span fg={T.dim}>{" core · running · main"}</span><span fg={T.faint}>{`${" ".repeat(Math.max(1, FW - 23 - p.keys.length))}${p.keys} `}</span></text>
    </box>
  </box>
)

// ── Pieces ──────────────────────────────────────────────────────────────────
const STAGES = ["Triage", "Refine", "Re-rehearse", "Plan"] as const
/** The stepper with each stage's count: what it holds, or how far it got. */
const Stepper = (p: { at: number; counts: ReadonlyArray<string> }) => (
  <text wrapMode="none">
    {STAGES.map((s, i) => {
      const done = i < p.at
      const here = i === p.at
      return (
        <span key={s}>
          <span fg={done ? T.ok : here ? T.accent : T.faint}>{done ? "✓ " : here ? "● " : "○ "}</span>
          <span fg={here ? T.text : done ? T.dim : T.faint}>{here ? <b>{s}</b> : s}</span>
          <span fg={here ? T.accent : T.dim}>{p.counts[i] !== "" ? ` ${p.counts[i]}` : ""}</span>
          {i < 3 ? <span fg={T.faint}>{"  ──  "}</span> : null}
        </span>
      )
    })}
  </text>
)
const Title = (p: { name: string; right: string }) => (
  <text wrapMode="none"><span fg={T.accent}><b>{p.name}</b></span><span fg={T.dim}>{`  ${p.right}`}</span></text>
)
const Head = (p: { t: string; right?: string; w: number }) => (
  <text wrapMode="none"><span fg={T.dim}><b>{p.t}</b></span>{p.right !== undefined ? <span fg={T.faint}>{`  ${p.right}`}</span> : null}<span fg={T.faint}>{` ${"─".repeat(Math.max(0, p.w - p.t.length - (p.right?.length ?? -2) - 3))}`}</span></text>
)
const Btn = (p: { label: string; k: string; primary?: boolean; count?: string }) => (
  <span>
    <span fg={p.primary ? T.accent : T.line}>▐</span>
    <span fg={p.primary ? T.bg : T.text} bg={p.primary ? T.accent : T.line}>{` ${p.label}${p.count !== undefined ? ` · ${p.count}` : ""} `}</span>
    <span fg={p.primary ? T.raised : T.dim} bg={p.primary ? T.accent : T.line}>{` ${p.k} `}</span>
    <span fg={p.primary ? T.accent : T.line}>▌</span>
    <span>{"  "}</span>
  </span>
)
const Gauge = (p: { done: number; total: number; w: number; tone?: string }) => {
  const f = Math.round((p.done / Math.max(1, p.total)) * p.w)
  return <span><span fg={p.tone ?? T.accent}>{"━".repeat(f)}</span><span fg={T.faint}>{"─".repeat(p.w - f)}</span></span>
}

// ── The journeys, left ──────────────────────────────────────────────────────
const JOURNEYS = [
  { name: "Talk with zarg", open: 68, on: 68, stage: 1, bar: [7, 15] as const },
  { name: "Reconcile", open: 57, on: 57, stage: 0 },
  { name: "Set up", open: 53, on: 53, stage: 0 },
  { name: "Watch agents", open: 11, on: 11, stage: 0 },
  { name: "CLI actor", open: 15, on: 9, stage: 0 },
]
/** The journeys as one strip under the stepper: each with its open count and its stage; the selected one underlined. */
const Journeys = (p: { at: number; stageOf?: (i: number) => number; bar?: string }) => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <text wrapMode="none">
      {JOURNEYS.map((j, i) => {
        const on = i === p.at
        const st = p.stageOf?.(i) ?? j.stage
        const label = on && p.bar !== undefined ? p.bar : st > 0 ? STAGES[st]! : ""
        return (
          <span key={j.name}>
            <span fg={on ? T.journey : T.dim}>{on ? <b>{j.name}</b> : j.name}</span>
            <span fg={T.dim}>{` ${j.open}${label !== "" ? " " : ""}`}</span>
            <span fg={st > 0 ? T.accent : T.faint}>{label}</span>
            <span fg={T.faint}>{i < JOURNEYS.length - 1 ? "  │  " : ""}</span>
          </span>
        )
      })}
    </text>
    <text wrapMode="none"><span fg={T.accent}>{"▔".repeat(("Talk with zarg 68" + (p.bar !== undefined ? ` ${p.bar}` : "")).length)}</span></text>
  </box>
)

// ── Feedback grouped by card ─────────────────────────────────────────────────
type Entry = { id: string; sev: string; kind: string; persona: string; note: string; on: boolean; mine?: string }
type CardGroup = { id: string; title: string; status?: "waiting" | "drafting" | "drafted" | "left" | "resolved" | "still"; entries: ReadonlyArray<Entry> }
const CARDS: ReadonlyArray<CardGroup> = [
  { id: "C-0071", title: "Driver Agent chooses for the operator", status: "drafted", entries: [
    { id: "F-6a10", sev: "high", kind: "gap", persona: "Driver Agent", note: "Settles on an option with no confirmation from the operator; it chose for them.", on: true, mine: "Ask before saving; the operator must confirm." },
    { id: "F-7c2e", sev: "medium", kind: "transition", persona: "Driver Agent", note: "After saving, nothing says the next question comes.", on: true },
  ] },
  { id: "C-0008", title: "Driver Agent opens with a question", status: "drafting", entries: [
    { id: "F-3d8e", sev: "high", kind: "transition", persona: "Driver Agent", note: "Ends at marking the recommended option; never says the operator answers it.", on: true },
    { id: "F-cdcb", sev: "high", kind: "gap", persona: "Driver Agent", note: "No branch when the operator picks another option or asks why.", on: true },
    { id: "F-cc4c", sev: "medium", kind: "friction", persona: "Driver Agent", note: "Marked: preselected, or only annotated?", on: true },
    { id: "F-6e6c", sev: "low", kind: "feature", persona: "Driver Agent", note: "Show why the option is recommended.", on: false },
  ] },
  { id: "C-0009", title: "Operator picks an option", status: "waiting", entries: [
    { id: "F-b40a", sev: "high", kind: "transition", persona: "Operator", note: "The save ends the step with no cue for what comes next.", on: true },
    { id: "F-fc5a", sev: "medium", kind: "contradiction", persona: "Operator", note: "'One question' yet the flag implies a choice after it.", on: true },
  ] },
  { id: "C-0018", title: "Driver Agent asks about conflicting edits", status: "left", entries: [
    { id: "F-11e0", sev: "medium", kind: "gap", persona: "Driver Agent", note: "No path when the operator keeps neither version.", on: true },
  ] },
]
const LW = 50
const statusGlyph = (s: CardGroup["status"]) =>
  s === "drafted" ? { g: "✓", t: T.ok, l: "drafted" } : s === "drafting" ? { g: "⠹", t: T.accent, l: "drafting" } : s === "left" ? { g: "✗", t: T.err, l: "left out" } : s === "resolved" ? { g: "✓", t: T.ok, l: "resolved" } : s === "still" ? { g: "!", t: T.attn, l: "still reported" } : s === "waiting" ? { g: "·", t: T.faint, l: "waiting" } : undefined
const Toggle = (p: { on: boolean }) => (p.on ? <span fg={T.ok}>{"● "}</span> : <span fg={T.faint}>{"○ "}</span>)
const CardList = (p: { cards: ReadonlyArray<CardGroup>; cursor: string; showStatus: boolean; rows?: number }) => {
  const out: Array<ReactNode> = []
  for (const c of p.cards) {
    const st = p.showStatus ? statusGlyph(c.status) : undefined
    const n = c.entries.filter((e) => e.on).length
    out.push(
      <text key={c.id} wrapMode="none">
        <span fg={T.card}><b>{c.id}</b></span>
        <span fg={T.text}>{` ${pad(c.title, LW - 9 - 12)}`}</span>
        {st !== undefined ? <span fg={st.t}>{` ${st.g} ${pad(st.l, 9)}`}</span> : <span fg={T.dim}>{`   ${String(n).padStart(2)} on    `}</span>}
      </text>,
    )
    for (const e of c.entries) {
      const here = e.id === p.cursor
      out.push(
        <text key={e.id} wrapMode="none" {...(here ? { bg: T.sel } : {})}>
          <span fg={T.accent}>{here ? "▍" : " "}</span>
          <span fg={T.faint}>{" "}</span>
          <Toggle on={e.on} />
          <span fg={sevTone(e.sev)}>{`${sevGlyph(e.sev)} `}</span>
          <span fg={e.on ? T.dim : T.faint}>{pad(e.kind, 11)}</span>
          <span fg={e.on ? T.text : T.faint}>{pad(e.note, LW - 20 - (e.mine !== undefined ? 2 : 0))}</span>
          {e.mine !== undefined ? <span fg={T.attn}>{" ✎"}</span> : null}
        </text>,
      )
    }
  }
  return <box style={{ width: LW, flexShrink: 0, flexDirection: "column" }}>{out.slice(0, p.rows ?? 99)}</box>
}

// ── The right pane: the card, the entry, the note ────────────────────────────
const RWD = FW - 4 - LW - 3
const Gwt = (p: { k: string; t: string; tone?: string; mark?: string }) => (
  <text wrapMode="none"><span fg={p.mark === "+" ? T.add : p.mark === "-" ? T.del : T.faint}>{p.mark ?? " "}</span><span fg={T.accent}>{`${pad(p.k, 6)}`}</span><span fg={p.tone ?? T.text}>{pad(p.t, RWD - 7)}</span></text>
)
const Wrapped = (p: { t: string; tone?: string; indent?: number; max?: number }) => (
  <>{wrap(p.t, RWD - (p.indent ?? 0), p.max).map((l, i) => <text key={i} wrapMode="none" fg={p.tone ?? T.text}>{`${" ".repeat(p.indent ?? 0)}${l}`}</text>)}</>
)
const Right = (p: { children: ReactNode }) => <box style={{ width: RWD, flexShrink: 0, flexDirection: "column", marginLeft: 3 }}>{p.children}</box>

// ── The live strip: the Triage Agent's last lines, under the hub ─────────────
const Strip = (p: { lines: ReadonlyArray<[string, string, string]>; head: string }) => (
  <box style={{ flexDirection: "column", flexShrink: 0, backgroundColor: T.shade, paddingLeft: 1, marginTop: 1 }}>
    <text wrapMode="none"><span fg={T.accent}>{"⠹ "}</span><span fg={T.text}><b>Triage Agent</b></span><span fg={T.dim}>{`  ${p.head}`}</span></text>
    {p.lines.map(([g, t, x], i) => (
      <text key={i} wrapMode="none"><span fg={g === "✓" ? T.ok : g === "✗" ? T.err : T.faint}>{`  ${g} `}</span><span fg={T.dim}>{pad(t, 8)}</span><span fg={T.text}>{pad(x, FW - 18)}</span></text>
    ))}
  </box>
)

// ── Frames ───────────────────────────────────────────────────────────────────
/** 1. Triage: entries grouped by card; the card as the tester read it beside them, the entry, your note. */
const Triage = () => (
  <>
    <text> </text>
    <Title name="Feedback" right="Talk with zarg · 68 open · 67 on · 1 noted" />
    <Stepper at={0} counts={["67 on", "", "", ""]} />
    <Journeys at={0} stageOf={() => 0} />
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <box style={{ flexDirection: "column" }}>
        <Head t="BY CARD" right="⌕ search" w={LW} />
        <CardList cards={CARDS.map((c) => ({ ...c }))} cursor="F-6a10" showStatus={false} />
      </box>
      <Right>
        <Head t="THE CARD" right="as the tester read it" w={RWD} />
        <Gwt k="Given" t="the question stays open for discussion" />
        <Gwt k="When" t="the conversation settles on one option" />
        <Gwt k="Then" t="the chosen option is shown with its reason" />
        <Gwt k="And" t="the answer is saved to the graph" />
        <text> </text>
        <Head t="F-6a10" right="gap · high · Driver Agent" w={RWD} />
        <Wrapped t="Settles on an option with no confirmation from the operator; it chose for them. Reported 3 times." />
        <text fg={T.dim} wrapMode="none">{"agent: on · fix · real 0.91"}</text>
        <text> </text>
        <text wrapMode="none"><span fg={T.attn}>{"✎ Your note"}</span></text>
        <Wrapped t="Ask before saving; the operator must confirm." tone={T.attn} indent={2} />
      </Right>
    </box>
    <text wrapMode="none"><Btn label="Refine" k="r" primary count="67 on · 15 cards" /><Btn label="Note" k="n" /><span fg={T.dim}>{"  space flips · the agent drafts, then re-rehearses, on its own"}</span></text>
  </>
)
/** 1b. A note being typed, under the list. */
const Noting = () => (
  <>
    <text> </text>
    <Title name="Feedback" right="Talk with zarg · 68 open · 67 on" />
    <Stepper at={0} counts={["67 on", "", "", ""]} />
    <Journeys at={0} stageOf={() => 0} />
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <box style={{ flexDirection: "column" }}>
        <Head t="BY CARD" right="⌕ search" w={LW} />
        <CardList cards={CARDS.slice(0, 2)} cursor="F-cdcb" showStatus={false} />
        <text> </text>
        <text wrapMode="none" bg={T.sel}><span fg={T.attn}>{" ✎ "}</span><span fg={T.text}>{"Offer 'why?' as an option; a different pick goes to C-0009"}</span><span fg={T.accent}>{"▎"}</span></text>
        <text wrapMode="none" fg={T.dim}>{"   ⏎ save · esc cancel · empty ⏎ clears"}</text>
      </box>
      <Right>
        <Head t="F-cdcb" right="gap · high · Driver Agent" w={RWD} />
        <Wrapped t="If the operator accepts a different option, or asks for clarification or refuses, the step has no branch to take." />
        <text> </text>
        <text fg={T.dim} wrapMode="none">{"Your note goes to the Triage Agent with"}</text>
        <text fg={T.dim} wrapMode="none">{"this entry; it wins over the tester's words."}</text>
      </Right>
    </box>
    <text wrapMode="none"><Btn label="Refine" k="r" primary count="67 on · 15 cards" /><Btn label="Note" k="n" /></text>
  </>
)
/** 2. Refine, running: each card's status, the drafted change for the highlighted card, and the agent's live strip. */
const Refine = () => (
  <>
    <text> </text>
    <Title name="Feedback" right="Talk with zarg · refining 15 cards" />
    <Stepper at={1} counts={["67 on", "7/15", "", ""]} />
    <text wrapMode="none"><span>{"  "}</span><Gauge done={7} total={15} w={40} /><span fg={T.dim}>{"  7 of 15 · 5 drafted · 2 left out · ~6 min left"}</span></text>
    <Journeys at={0} bar="Refine 7/15" />
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <box style={{ flexDirection: "column" }}>
        <Head t="BY CARD" right="drafted first" w={LW} />
        <CardList cards={CARDS} cursor="F-6a10" showStatus rows={14} />
      </box>
      <Right>
        <Head t="C-0071" right="drafted · 4 changes" w={RWD} />
        <Gwt k="Given" t="the question stays open for discussion" />
        <Gwt k="When" t="the conversation settles on one option" mark="-" tone={T.del} />
        <Gwt k="When" t="the operator confirms one option" mark="+" tone={T.add} />
        <Gwt k="Then" t="the chosen option is shown with its reason" />
        <Gwt k="And" t="the answer is saved to the graph" />
        <Gwt k="And" t="the saved answer carries option and reason" mark="+" tone={T.add} />
        <Gwt k="And" t="the operator can amend the saved choice" mark="+" tone={T.add} />
        <text> </text>
        <Wrapped t="Answers F-6a10 and your note: the operator now confirms before anything is saved." tone={T.dim} />
      </Right>
    </box>
    <Strip head="drafting C-0008 · 38 s · 4 feedback" lines={[["✓", "C-0019", "into the draft: conflict resolution shows both versions with their origins"], ["✓", "C-0071", "into the draft: the operator confirms; the saved answer carries option and reason"], ["✗", "C-0018", "left out: the model gave no answer (token limit, 4096 of them reasoning)"]]} />
  </>
)
/** 3. Re-rehearse: testers walk the journey on the drafted cards; each persona's progress. */
const TESTERS = [
  { p: "Operator", done: 14, total: 22, now: "C-0009 Operator picks an option", found: 1 },
  { p: "Driver Agent", done: 22, total: 22, now: "done", found: 0 },
  { p: "CLI actor", done: 3, total: 6, now: "C-0001 CLI actor reads the agenda", found: 0 },
]
const Rehearse = () => (
  <>
    <text> </text>
    <Title name="Feedback" right="Talk with zarg · re-rehearsing on the drafted cards" />
    <Stepper at={2} counts={["67 on", "13 drafted", "run r-4c1a", ""]} />
    <text> </text>
    <Journeys at={0} stageOf={(i) => (i === 0 ? 2 : 0)} bar="Re-rehearse 39/50" />
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <box style={{ flexDirection: "column", width: FW - 4 }}>
        <Head t="TESTERS" right="18 stories · 50 steps · on the draft, nothing filed" w={FW - 4} />
        {TESTERS.map((t) => (
          <box key={t.p} style={{ flexDirection: "column", marginBottom: 1 }}>
            <text wrapMode="none"><span fg={t.done === t.total ? T.ok : T.accent}>{t.done === t.total ? "✓ " : "⠹ "}</span><span fg={T.text}>{pad(t.p, 14)}</span><Gauge done={t.done} total={t.total} w={24} tone={t.done === t.total ? T.ok : T.accent} /><span fg={T.dim}>{`  ${t.done}/${t.total} steps`}</span><span fg={t.found > 0 ? T.attn : T.dim}>{`   ${t.found > 0 ? `${t.found} still reported` : "nothing yet"}`}</span></text>
            <text wrapMode="none" fg={T.dim}>{`  ${t.now}`}</text>
          </box>
        ))}
        <Head t="SO FAR" w={FW - 4} />
        <text wrapMode="none"><span fg={T.ok}>{"✓ 41 resolved   "}</span><span fg={T.attn}>{"! 1 still reported   "}</span><span fg={T.dim}>{"◇ 0 new   · 25 not walked yet"}</span></text>
        <text wrapMode="none"><span fg={T.attn}>{"! C-0009 "}</span><span fg={T.text}>{"transition · the save still ends with no cue for what comes next"}</span></text>
      </box>
    </box>
    <text wrapMode="none"><Btn label="Refine again" k="r" /><span fg={T.dim}>{"  stops the run and refines what is still on · Plan comes when every tester is done"}</span></text>
  </>
)
/** 4. Plan: the plan, what it changes card by card, what it closes, what was left out; Accept or Refine again. */
const Plan = () => (
  <>
    <text> </text>
    <Title name="Feedback" right="Talk with zarg · plan ready" />
    <Stepper at={3} counts={["67 on", "13 drafted", "41 resolved", "ready"]} />
    <text> </text>
    <Journeys at={0} stageOf={(i) => (i === 0 ? 3 : 0)} bar="Plan · ready" />
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <box style={{ flexDirection: "column", width: LW }}>
        <Head t="STILL REPORTED" right="2" w={LW} />
        <CardList cards={[{ id: "C-0009", title: "Operator picks an option", status: "still", entries: [{ id: "F-b40a", sev: "high", kind: "transition", persona: "Operator", note: "The save ends the step with no cue for what comes next.", on: true }] }, { id: "C-0018", title: "Driver Agent asks about conflicting edits", status: "left", entries: [{ id: "F-11e0", sev: "medium", kind: "gap", persona: "Driver Agent", note: "No path when the operator keeps neither version.", on: true }] }]} cursor="F-b40a" showStatus />
        <text> </text>
        <Head t="RESOLVED" right="41 · on the draft" w={LW} />
        <text wrapMode="none" fg={T.dim}>{"✓ C-0071 ·2  ✓ C-0008 ·4  ✓ C-0010 ·4  ✓ C-0019 ·3"}</text>
        <text wrapMode="none" fg={T.dim}>{"✓ C-0012 ·5  ✓ C-0013 ·3  … 7 more cards"}</text>
      </box>
      <Right>
        <Head t="THE PLAN" right="B-03 when accepted" w={RWD} />
        <Wrapped t="The operator confirms each answer; every save says what comes next" max={2} />
        <text> </text>
        {["1. Confirm before saving (C-0071, C-0009)", "2. A branch for another pick (C-0008)", "3. Stop when the agenda is empty (C-0010)", "4. Conflicts show both versions (C-0019)"].map((l) => <text key={l} wrapMode="none" fg={T.text}>{pad(l, RWD)}</text>)}
        <text> </text>
        <text wrapMode="none"><span fg={T.dim}>{"changes  "}</span><span fg={T.card}>{"13 cards"}</span><span fg={T.dim}>{" · "}</span><span fg={T.add}>{"+2 new"}</span><span fg={T.dim}>{" · 31 calls"}</span></text>
        <text wrapMode="none"><span fg={T.dim}>{"closes   "}</span><span fg={T.text}>{"41 feedback"}</span></text>
        <text wrapMode="none"><span fg={T.dim}>{"left out "}</span><span fg={T.err}>{"C-0018"}</span><span fg={T.dim}>{" no answer"}</span></text>
        <text wrapMode="none"><span fg={T.dim}>{"goes to  "}</span><span fg={T.text}>{"Backlog · Ready"}</span></text>
      </Right>
    </box>
    <text wrapMode="none"><Btn label="Accept" k="a" primary count="to the Backlog" /><Btn label="Refine again" k="r" count="2 cards" /><Btn label="Note" k="n" /></text>
  </>
)
/** 5. The Triage Agent's own view: every journey it works, each card's outcome, timing and tokens, and what the model said. */
// ── The Triage Agent: its view, and its panel ─────────────────────────────────
type Row = { g: string; card: string; title: string; what: string; t: string; tin: string; tout: string; think: number; why: string }
const ROWS: ReadonlyArray<Row> = [
  { g: "✓", card: "C-0071", title: "Driver Agent chooses for the operator", what: "drafted", t: "41 s", tin: "5.2k", tout: "1.8k", think: 0.62, why: "the operator confirms; the saved answer carries option and reason" },
  { g: "✓", card: "C-0019", title: "Operator picks a version", what: "drafted", t: "38 s", tin: "6.0k", tout: "2.1k", think: 0.55, why: "conflict resolution shows both versions with their origins" },
  { g: "✗", card: "C-0012", title: "Operator chats about the question", what: "left out", t: "4 m 12 s", tin: "5.8k", tout: "16.4k", think: 1, why: "1st: no answer, 16384 tokens all reasoning · 2nd: 6 thens (1-5)" },
  { g: "↻", card: "C-0077", title: "Operator sees a diagram", what: "drafted", t: "1 m 20 s", tin: "4.9k", tout: "3.3k", think: 0.7, why: "2nd try: the 1st had a clause with 'if'" },
  { g: "⠹", card: "C-0017", title: "Driver Agent merges compatible edits", what: "drafting", t: "38 s", tin: "", tout: "", think: 0, why: "4 feedback on" },
  { g: "·", card: "C-0010", title: "Driver Agent asks the next question", what: "waiting", t: "", tin: "", tout: "", think: 0, why: "4 feedback" },
  { g: "·", card: "C-0008", title: "Driver Agent opens with a question", what: "waiting", t: "", tin: "", tout: "", think: 0, why: "4 feedback · 1 note" },
  { g: "·", card: "C-0009", title: "Operator picks an option", what: "waiting", t: "", tin: "", tout: "", think: 0, why: "5 feedback" },
]
const gTone = (g: string) => (g === "✓" ? T.ok : g === "✗" ? T.err : g === "↻" ? T.attn : g === "⠹" ? T.accent : T.faint)
/** How much of the answer went on reasoning: a bar that fills red at the limit. */
const Think = (p: { f: number }) => {
  const n = Math.round(p.f * 6)
  return <span><span fg={p.f >= 1 ? T.err : T.faint}>{"▮".repeat(n)}</span><span fg={T.line}>{"▯".repeat(6 - n)}</span></span>
}
const JOBS = [
  { j: "Talk with zarg", stage: "Refine", note: "8 of 15 cards", g: "⠹", tone: T.accent },
  { j: "Reconcile", stage: "Triage", note: "57 open · waits for your Refine", g: "·", tone: T.faint },
  { j: "Set up", stage: "Plan", note: "B-02 backlogged 2 h ago", g: "✓", tone: T.ok },
]
const Jobs = () => (
  <>
    {JOBS.map((x) => (
      <text key={x.j} wrapMode="none"><span fg={x.tone}>{` ${x.g} `}</span><span fg={T.journey}>{pad(x.j, 16)}</span><span fg={x.g === "⠹" ? T.accent : T.dim}>{pad(x.stage, 13)}</span><span fg={T.dim}>{x.note}</span></text>
    ))}
  </>
)
const Summary = (p: { right: string }) => (
  <>
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>Triage Agent</b></span><span fg={T.dim}>{`  ${p.right}`}</span></text>
  </>
)
const Stat = (p: { k: string; v: string; tone?: string }) => <span><span fg={p.tone ?? T.text}><b>{p.v}</b></span><span fg={T.dim}>{` ${p.k}   `}</span></span>
const CardTable = (p: { cursor: string; w: number; rows?: number; data?: ReadonlyArray<Row> }) => (
  <>
    <text wrapMode="none" fg={T.faint}>{`    ${pad("card", 9)}${pad("", 26)}${pad("time", 10)}${pad("in → out", 13)}${pad("think", 8)}why`}</text>
    {(p.data ?? ROWS).slice(0, p.rows ?? 99).map((r) => {
      const here = r.card === p.cursor
      return (
        <text key={r.card} wrapMode="none" {...(here ? { bg: T.sel } : {})}>
          <span fg={T.accent}>{here ? "▍" : " "}</span>
          <span fg={gTone(r.g)}>{`${r.g}  `}</span>
          <span fg={T.card}>{pad(r.card, 9)}</span>
          <span fg={r.g === "·" ? T.dim : T.text}>{pad(r.title, 26)}</span>
          <span fg={T.dim}>{pad(r.t, 10)}</span>
          <span fg={T.faint}>{pad(r.tin === "" ? "" : `${r.tin} → ${r.tout}`, 13)}</span>
          {r.think > 0 ? <Think f={r.think} /> : <span>{"      "}</span>}
          <span>{"  "}</span>
          <span fg={r.g === "✗" ? T.err : T.dim}>{pad(r.why, Math.max(4, p.w - 4 - 9 - 26 - 10 - 13 - 8))}</span>
        </text>
      )
    })}
  </>
)
/** A. Working: what it is on, every card's outcome with time, tokens and how much went on reasoning, the other journeys. */
const AgentWorking = () => (
  <>
    <Summary right="refining Talk with zarg · driver deepseek-v4.1-flash · 16k tokens per answer" />
    <text wrapMode="none"><span>{" "}</span><Gauge done={8} total={15} w={30} /><span>{"   "}</span><Stat v="8/15" k="cards" /><Stat v="3" k="drafted" tone={T.ok} /><Stat v="1" k="retried" tone={T.attn} /><Stat v="6" k="left out" tone={T.err} /><Stat v="~9 min" k="left" /></text>
    <text> </text>
    <Head t="NOW" w={FW - 4} />
    <text wrapMode="none"><span fg={T.accent}>{" ⠹ "}</span><span fg={T.card}>{"C-0017 "}</span><span fg={T.text}>{"Driver Agent merges compatible edits"}</span><span fg={T.dim}>{"  · drafting · 38 s · 4 feedback on"}</span></text>
    <text> </text>
    <Head t="TALK WITH ZARG" right="15 cards · drafted first" w={FW - 4} />
    <CardTable cursor="C-0017" w={FW - 4} rows={8} />
    <text wrapMode="none" fg={T.dim}>{"     … 7 more waiting · 5 left out in an earlier round"}</text>
    <text> </text>
    <Head t="JOURNEYS" w={FW - 4} />
    <Jobs />
    <text> </text>
    <text wrapMode="none"><Btn label="Open Feedback" k="⏎" primary /><Btn label="Stop" k="x" /><span fg={T.dim}>{"  ↑↓ a card shows its tries"}</span></text>
  </>
)
/** B. A card opened (a failed one): each try, what the model spent and said, why it was left out, and the change it proposed. */
const AgentCard = () => (
  <>
    <Summary right="refining Talk with zarg · 8/15" />
    <text> </text>
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <box style={{ flexDirection: "column", width: 40, flexShrink: 0 }}>
        <Head t="CARDS" right="8/15" w={40} />
        {ROWS.map((r) => {
          const here = r.card === "C-0012"
          return (
            <text key={r.card} wrapMode="none" {...(here ? { bg: T.sel } : {})}>
              <span fg={T.accent}>{here ? "▍" : " "}</span>
              <span fg={gTone(r.g)}>{`${r.g} `}</span>
              <span fg={T.card}>{`${r.card} `}</span>
              <span fg={T.dim}>{pad(r.what, 10)}</span>
              <span fg={T.faint}>{pad(r.t, 9)}</span>
              {r.think > 0 ? <Think f={r.think} /> : null}
            </text>
          )
        })}
      </box>
      <box style={{ flexDirection: "column", marginLeft: 3, flexGrow: 1 }}>
        <Head t="C-0012" right="left out" w={FW - 4 - 43} />
        <text wrapMode="none" fg={T.text}>{"Operator chats about the question"}</text>
        <text wrapMode="none" fg={T.dim}>{"5 feedback on · no note · 4 m 12 s over 2 tries"}</text>
        <text> </text>
        <text wrapMode="none"><span fg={T.err}>{"✗ try 1  "}</span><span fg={T.dim}>{"3 m 02 s · 5.8k → 16.4k  "}</span><Think f={1} /></text>
        <text wrapMode="none" fg={T.text}>{"   no answer: it stopped at the 16384-token"}</text>
        <text wrapMode="none" fg={T.text}>{"   limit, all of it reasoning"}</text>
        <text wrapMode="none"><span fg={T.err}>{"✗ try 2  "}</span><span fg={T.dim}>{"1 m 10 s · 6.1k → 4.9k  "}</span><Think f={0.7} /></text>
        <text wrapMode="none" fg={T.text}>{"   failed its checks: C-0012 would have"}</text>
        <text wrapMode="none" fg={T.text}>{"   6 thens; it needs 1-5"}</text>
        <text> </text>
        <Head t="WHAT IT PROPOSED" right="try 2 · not in the draft" w={FW - 4 - 43} />
        <text wrapMode="none"><span fg={T.faint}>{" "}</span><span fg={T.accent}>{"When  "}</span><span fg={T.text}>{"the operator picks Chat about this"}</span></text>
        {["the question stays open", "the chat takes the message", "the Driver Agent answers", "the options stay beside it", "an option can be picked", "picking one closes it"].map((t, i) => (
          <text key={t} wrapMode="none"><span fg={i >= 1 ? T.add : T.faint}>{i >= 1 ? "+" : " "}</span><span fg={T.accent}>{i === 0 ? "Then  " : "And   "}</span><span fg={i === 5 ? T.err : i >= 1 ? T.add : T.text}>{t}</span>{i === 5 ? <span fg={T.err}>{"  ← the 6th"}</span> : null}</text>
        ))}
        <text> </text>
        <text wrapMode="none" fg={T.dim}>{"d drafts it again, with what failed"}</text>
        <text wrapMode="none" fg={T.dim}>{"as the model's first feedback."}</text>
      </box>
    </box>
    <text wrapMode="none"><Btn label="Draft again" k="d" primary /><Btn label="Open Feedback" k="⏎" /><span fg={T.dim}>{"  d retries this card now, over the draft as it is"}</span></text>
  </>
)
/** C. Re-rehearsing: one line for the run (its testers live in rehearse's view, ⏎ opens it), then the round it walks. */
const AgentRehearse = () => (
  <>
    <Summary right="re-rehearsing Talk with zarg over the draft" />
    <text wrapMode="none"><span>{" "}</span><Stat v="15" k="cards" /><Stat v="10" k="drafted" tone={T.ok} /><Stat v="1" k="retried" tone={T.attn} /><Stat v="5" k="left out" tone={T.err} /><Stat v="38 min" k="this round" /></text>
    <text> </text>
    <Head t="NOW" w={FW - 4} />
    <text wrapMode="none" bg={T.sel}><span fg={T.accent}>{"▍⠹ "}</span><span fg={T.text}>{"re-rehearsing on the draft"}</span><span fg={T.dim}>{"  · run r-4c1a · 3 testers · 39/50 steps · 12 min"}</span><span fg={T.accent}>{"  ⏎ opens it"}</span></text>
    <text wrapMode="none" fg={T.dim}>{"   the result goes to Feedback: what is resolved, what is still reported, on to Plan"}</text>
    <text> </text>
    <Head t="TALK WITH ZARG" right="the draft it walks" w={FW - 4} />
    <CardTable cursor="" w={FW - 4} rows={5} data={[...ROWS.slice(0, 4), { ...ROWS[4]!, g: "✓", what: "drafted", t: "44 s", tin: "5.5k", tout: "2.0k", think: 0.5, why: "compatible edits merge; the operator is told which" }]} />
    <text wrapMode="none" fg={T.dim}>{"     … 6 more drafted · 4 more left out"}</text>
    <text> </text>
    <Head t="JOURNEYS" w={FW - 4} />
    <text wrapMode="none"><span fg={T.accent}>{" ⠹ "}</span><span fg={T.journey}>{pad("Talk with zarg", 16)}</span><span fg={T.accent}>{pad("Re-rehearse", 13)}</span><span fg={T.dim}>{"run r-4c1a · 39/50 steps"}</span></text>
    <text wrapMode="none"><span fg={T.faint}>{" · "}</span><span fg={T.journey}>{pad("Reconcile", 16)}</span><span fg={T.dim}>{pad("Triage", 13)}</span><span fg={T.dim}>{"57 open · waits for your Refine"}</span></text>
    <text wrapMode="none"><span fg={T.ok}>{" ✓ "}</span><span fg={T.journey}>{pad("Set up", 16)}</span><span fg={T.dim}>{pad("Planned", 13)}</span><span fg={T.dim}>{"B-02 on the Backlog · Ready"}</span></text>
    <text> </text>
    <text wrapMode="none"><Btn label="Open the run" k="⏎" primary /><Btn label="Open Feedback" k="f" /><Btn label="Stop the run" k="x" /></text>
  </>
)
/** D. Idle: nothing to do; each journey's stage and what it waits for, the last work it did. */
const AgentIdle = () => (
  <>
    <Summary right="idle · wakes when a journey is refined or a run ends" />
    <text> </text>
    <Head t="JOURNEYS" right="what each waits for" w={FW - 4} />
    <text wrapMode="none"><span fg={T.attn}>{" ◆ "}</span><span fg={T.journey}>{pad("Talk with zarg", 16)}</span><span fg={T.attn}>{pad("Plan", 13)}</span><span fg={T.text}>{"plan ready: a accept or r refine again, in Feedback"}</span></text>
    <text wrapMode="none"><span fg={T.faint}>{" · "}</span><span fg={T.journey}>{pad("Reconcile", 16)}</span><span fg={T.dim}>{pad("Triage", 13)}</span><span fg={T.dim}>{"57 open · waits for your Refine"}</span></text>
    <text wrapMode="none"><span fg={T.faint}>{" · "}</span><span fg={T.journey}>{pad("Watch agents", 16)}</span><span fg={T.dim}>{pad("Triage", 13)}</span><span fg={T.dim}>{"11 open · waits for your Refine"}</span></text>
    <text wrapMode="none"><span fg={T.ok}>{" ✓ "}</span><span fg={T.journey}>{pad("Set up", 16)}</span><span fg={T.dim}>{pad("Planned", 13)}</span><span fg={T.dim}>{"B-02 on the Backlog · Ready"}</span></text>
    <text> </text>
    <Head t="LAST ROUND" right="Talk with zarg · 38 min" w={FW - 4} />
    <text wrapMode="none"><span>{" "}</span><Stat v="15" k="cards" /><Stat v="10" k="drafted" tone={T.ok} /><Stat v="5" k="left out" tone={T.err} /><Stat v="41" k="resolved" tone={T.ok} /><Stat v="2" k="still reported" tone={T.attn} /></text>
    <text wrapMode="none"><span>{" "}</span><Stat v="46 s" k="per card" /><Stat v="1.2M" k="tokens" /><Stat v="71%" k="of them reasoning" /></text>
    <text> </text>
    <Head t="WHY CARDS WERE LEFT OUT" w={FW - 4} />
    {[["3", "no answer: the token limit went on reasoning", "C-0018 C-0011 C-0012"], ["1", "failed its checks: too many thens", "C-0015"], ["1", "no JSON in the answer", "C-0076"]].map(([n, w, c]) => (
      <text key={w} wrapMode="none"><span fg={T.err}>{` ${n}× `}</span><span fg={T.text}>{pad(w, 48)}</span><span fg={T.card}>{c}</span></text>
    ))}
    <text> </text>
    <text wrapMode="none"><Btn label="Open Feedback" k="⏎" primary /></text>
  </>
)
/** E. Its panel: a narrow strip at the tile's right edge while it works, over any view. */
const PW = 34
const Panel = () => (
  <box style={{ width: PW, flexShrink: 0, flexDirection: "column", backgroundColor: T.raised, border: ["left"], borderColor: T.line, paddingLeft: 1 }}>
    <text wrapMode="none"><span fg={T.accent}>{"⠹ "}</span><span fg={T.text}><b>Triage Agent</b></span><span fg={T.faint}>{"          ×"}</span></text>
    <text wrapMode="none" fg={T.dim}>{"Talk with zarg · Refine"}</text>
    <text wrapMode="none"><Gauge done={8} total={15} w={20} /><span fg={T.dim}>{" 8/15"}</span></text>
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}>{"⠹ "}</span><span fg={T.card}>{"C-0017 "}</span><span fg={T.dim}>{"38 s"}</span></text>
    <text wrapMode="none"><span>{"  "}</span><Think f={0.4} /><span fg={T.dim}>{" 2.3k reasoning"}</span></text>
    <text> </text>
    {ROWS.filter((r) => r.g !== "·" && r.g !== "⠹").map((r) => (
      <box key={r.card} style={{ flexDirection: "column" }}>
        <text wrapMode="none"><span fg={gTone(r.g)}>{`${r.g} `}</span><span fg={T.card}>{`${r.card} `}</span><span fg={T.dim}>{r.what}</span></text>
        {wrap(r.why, PW - 3, 2).map((l, i) => <text key={i} wrapMode="none" fg={r.g === "✗" ? T.err : T.faint}>{`  ${l}`}</text>)}
      </box>
    ))}
    <text> </text>
    <text wrapMode="none" fg={T.dim}>{"⏎ open · × close"}</text>
  </box>
)
const Backlog = () => (
  <box style={{ flexDirection: "column", flexGrow: 1 }}>
    <text> </text>
    <text wrapMode="none"><span fg={T.accent}><b>Backlog</b></span><span fg={T.dim}>{"  2 plans"}</span></text>
    <text> </text>
    <text wrapMode="none"><span fg={T.dim}>{"Backlog 0 ◂   "}</span><span fg={T.text}><b>{"Ready 1"}</b></span><span fg={T.dim}>{" ◂   Running 0 ◂   Review 1 ◂"}</span></text>
    <text wrapMode="none" fg={T.accent}>{"              ▔▔▔▔▔▔▔"}</text>
    <text wrapMode="none"><span fg={T.faint}>{"               "}</span><span fg={T.err}>{"▌"}</span><span fg={T.text}>{" B-02 C-0030"}</span></text>
    <text wrapMode="none"><span fg={T.faint}>{"               "}</span><span fg={T.err}>{"▌"}</span><span fg={T.text}>{" Grant prompt names"}</span></text>
    <text wrapMode="none"><span fg={T.faint}>{"               "}</span><span fg={T.err}>{"▌"}</span><span fg={T.text}>{" its choices"}</span></text>
  </box>
)
const PanelFrame = () => (
  <box style={{ flexDirection: "row", flexGrow: 1 }}>
    <box style={{ flexDirection: "column", flexGrow: 1 }}><Backlog /></box>
    <Panel />
  </box>
)

// ── render ────────────────────────────────────────────────────────────────
const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const out: Record<string, string> = {}
const frames: ReadonlyArray<[string, ReactNode]> = [
  ["working", <Screen at="agent" busy="8/15" keys="↑↓ card · ⏎ open Feedback · x stop · esc back"><AgentWorking /></Screen>],
  ["card", <Screen at="agent" busy="8/15" keys="↑↓ card · d draft again · ⏎ open Feedback · esc back"><AgentCard /></Screen>],
  ["rehearse", <Screen at="agent" busy="run" keys="⏎ open the run · f Feedback · x stop the run · esc back"><AgentRehearse /></Screen>],
  ["idle", <Screen at="agent" keys="⏎ open Feedback · esc back"><AgentIdle /></Screen>],
]
for (const [k, node] of frames) {
  const t = await testRender(node, { width: W, height: 32, exitOnCtrlC: false, exitSignals: [] })
  await t.renderOnce()
  out[k] = t.captureSpans().lines.map((l) => l.spans.map((sp) => `<span style="color:${hex(sp.fg)};background:${hex(sp.bg)}${sp.attributes & 1 ? ";font-weight:700" : ""}">${esc(sp.text)}</span>`).join("")).join("\n")
  if (!process.argv.includes("--html")) console.log(`\n── ${k} ──\n${t.captureCharFrame()}`)
  t.renderer.destroy()
}
if (process.argv.includes("--html")) await Bun.write(process.argv.at(-1)!, JSON.stringify(out))
