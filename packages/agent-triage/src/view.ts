import type { StageView } from "./triage"

type Try = { readonly ms: number; readonly tokensIn: number; readonly tokensOut: number; readonly reasoning: number; readonly finish?: string; readonly problems: ReadonlyArray<string> }
type P = StageView["proposals"][number]
/** What the agent is on: a card in a Refine round, or (card "") the re-rehearse run it waits on. */
export type Working = { readonly journey: string; readonly card: string; readonly since: number }
type Row = { readonly id: string; readonly cells: Readonly<Record<string, string>>; readonly tone?: "error" | "dim"; readonly busy?: true }

export const dur = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${Math.max(1, s)} s` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`
}
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const sum = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0)
const triesOf = (p: P): ReadonlyArray<Try> => p.tries ?? []
/** How much of an answer went on reasoning, at its worst try: six cells, full when it hit the limit. */
const think = (ts: ReadonlyArray<Try>) => {
  if (ts.length === 0) return ""
  const f = Math.max(...ts.map((t) => (t.finish === "length" ? 1 : t.tokensOut === 0 ? 0 : t.reasoning / t.tokensOut)))
  const n = Math.round(f * 6)
  return `${"▮".repeat(n)}${"▯".repeat(6 - n)}`
}
const plural = (n: number, s: string) => `${n} ${n === 1 ? s : s.endsWith("y") ? `${s.slice(0, -1)}ies` : `${s}s`}`
const decided = (st: StageView) => st.proposals.filter((p) => p.status === "accepted" || p.status === "skipped")
const glyph = (p: P, inFlight: boolean) => (p.status === "accepted" ? (triesOf(p).length > 1 ? "↻" : "✓") : p.status === "skipped" ? "✗" : inFlight ? "⠋" : "·")
const STAGE = { triage: "Triage", refine: "Refine", rehearse: "Re-rehearse", plan: "Plan", planned: "Planned" } as const

const inTriage = (s: StageView) => s.stage === "refine" || s.stage === "rehearse"
const doneOf = (s: StageView) => `${decided(s).length}/${s.proposals.length} cards`

/** One worker's view: what it is on, its journey's cards (each with its tries and change, beside the list). */
export const workerView = (o: {
  readonly stage?: StageView
  readonly working?: Working
  readonly now: number
  /** Each drafted card's change, as a diff to show in its detail. */
  readonly diffs: Readonly<Record<string, string>>
}) => {
  const st = o.stage
  const elapsed = o.working !== undefined ? o.now - o.working.since : 0
  const lines: Array<string> = []
  if (st === undefined) lines.push("**free** · takes the next journey in line")
  else if (st.stage === "refine") {
    const done = decided(st)
    // Only cards whose tries were kept say how long a card takes.
    const timed = done.filter((p) => triesOf(p).length > 0)
    const avg = sum(timed.map((p) => sum(triesOf(p).map((t) => t.ms)))) / Math.max(1, timed.length)
    const waiting = st.proposals.filter((p) => p.status === "waiting").length
    const left = timed.length > 0 ? ` · ~${Math.max(1, Math.round((avg * waiting - elapsed) / 60_000))} min left` : ""
    lines.push(`**refining ${st.journey}** · ${done.length}/${st.proposals.length} cards · ${st.proposals.filter((p) => p.status === "accepted").length} drafted · ${st.proposals.filter((p) => p.status === "accepted" && triesOf(p).length > 1).length} retried · ${done.filter((p) => p.status === "skipped").length} left out${left}`)
    const p = st.proposals.find((x) => x.card === o.working?.card)
    if (p !== undefined) lines.push("", `**${p.card}**${p.title !== undefined ? ` ${p.title}` : ""} · drafting`)
  } else if (st.stage === "rehearse") lines.push(`**re-rehearsing ${st.journey}** over the draft`, "", `run ${st.run ?? "starting"} · its testers are in rehearse's view`, "The result goes to Feedback: what is resolved, what is still reported, on to Plan.")
  else lines.push(`**${st.journey}** · ${st.stage === "plan" ? (st.plan !== undefined ? "plan ready in Feedback" : "drafting the plan") : "done"}`)

  const cards: Array<Row> = []
  const details: Record<string, string> = {}
  for (const p of st?.proposals ?? []) {
    const inFlight = o.working !== undefined && o.working.card === p.card
    const ts = triesOf(p)
    cards.push({
      id: p.card,
      cells: { g: glyph(p, inFlight), card: `gherkin/card:${p.card}` },
      // The shell spins its first cell while it is drafted.
      ...(inFlight ? { busy: true as const } : {}),
      ...(p.status === "skipped" ? { tone: "error" as const } : p.status === "waiting" && !inFlight ? { tone: "dim" as const } : {}),
    })
    const status = p.status === "accepted" ? "drafted" : p.status === "skipped" ? "left out" : inFlight ? "drafting" : "waiting"
    details[p.card] = [
      `**${p.card}**${p.title !== undefined ? ` ${p.title}` : ""} · ${status}`,
      ...(ts.length > 0 ? [`${ts.length === 1 ? "1 try" : `${ts.length} tries`} · ${dur(sum(ts.map((t) => t.ms)))} · ${k(sum(ts.map((t) => t.tokensIn)))} → ${k(sum(ts.map((t) => t.tokensOut)))} tokens`] : []),
      "",
      ...ts.flatMap((t, i) => [
        `${t.problems.length === 0 ? "✓" : "✗"} try ${i + 1} · ${dur(t.ms)} · ${k(t.tokensIn)} → ${k(t.tokensOut)} · ${k(t.reasoning)} reasoning${t.finish === "length" ? " · stopped at the token limit" : ""}`,
        `  ${think([t])} reasoning`,
        ...t.problems.map((x) => `  ${x}`),
      ]),
      // What it is doing, when it has no tries to show.
      ...(inFlight ? ["Asking the model about this card now; its tries show here when it answers."] : []),
      ...(p.status === "waiting" && !inFlight ? [`Waiting its turn.${(p.problems ?? []).length > 0 ? ` Drafted again after: ${p.problems!.join("; ")}` : ""}`] : []),
      ...(p.status === "skipped" && ts.length === 0 ? [`Left out: ${(p.problems ?? []).join("; ")}`] : []),
      ...(p.status === "accepted" ? ["", p.summary, ...(o.diffs[p.card] !== undefined ? ["", o.diffs[p.card]!] : [])] : []),
      ...(p.status === "skipped" && p.changes.length > 0 ? ["", "**Proposed** (not in the draft)", ...p.changes.map((c) => `- ${c.tool} ${JSON.stringify(c.params)}`)] : []),
      ...(p.status !== "waiting" ? ["", "d drafts it again, with what failed passed to the model."] : []),
    ].join("\n")
  }
  return { summary: lines.join("\n"), cards, details }
}

/** The triage rollup (its parent agent): how many workers are busy, each worker, the journeys in line and what each waits for. */
export const rollupView = (o: {
  readonly stages: ReadonlyArray<StageView>
  readonly journeys: ReadonlyArray<{ readonly name: string; readonly open: number }>
  readonly workers: ReadonlyArray<{ readonly id: string; readonly journey?: string; readonly working?: Working }>
  readonly paused: boolean
}) => {
  const stageOf = (j: string) => o.stages.find((s) => s.journey === j)
  const line = o.stages.filter((s) => inTriage(s) && s.worker === undefined).sort((a, b) => (a.queued ?? 0) - (b.queued ?? 0))
  const busy = o.workers.filter((w) => w.journey !== undefined)
  const all = o.stages.flatMap((s) => (inTriage(s) || s.stage === "plan" ? s.proposals : []))
  const lines = [
    ...(o.paused ? ["**paused** · p resumes", ""] : []),
    `**${busy.length} of ${o.workers.length} workers busy** · ${line.length} queued · ${all.filter((p) => p.status === "accepted").length} cards drafted · ${all.filter((p) => p.status === "skipped").length} left out`,
  ]
  const workers: Array<Row> = o.workers.map((w) => {
    const st = w.journey !== undefined ? stageOf(w.journey) : undefined
    const now = st === undefined ? "free" : st.stage === "refine" ? `Refine ${doneOf(st)}${w.working !== undefined && w.working.card !== "" ? ` · ${w.working.card}` : ""}` : st.stage === "rehearse" ? `Re-rehearse · run ${st.run ?? "starting"}` : st.stage === "plan" ? "drafting the plan" : "done"
    return { id: w.id, ...(w.working !== undefined ? { busy: true as const } : {}), cells: { g: w.working !== undefined ? "⠋" : st !== undefined ? "●" : "·", worker: w.id, journey: w.journey ?? "", now }, ...(st === undefined ? { tone: "dim" as const } : {}) }
  })
  // Worked first, then the line, then plans to answer, then the rest.
  const rank = (s: StageView | undefined) => (s === undefined ? 3 : inTriage(s) ? (s.worker !== undefined ? 0 : 1) : s.stage === "plan" ? 2 : s.stage === "planned" ? 4 : 3)
  const names = [...new Set([...o.journeys.map((j) => j.name), ...o.stages.map((s) => s.journey)])]
  const sorted = names.map((n, i) => ({ n, i, s: stageOf(n) })).sort((a, b) => rank(a.s) - rank(b.s) || (a.s?.queued ?? 0) - (b.s?.queued ?? 0) || a.i - b.i)
  const journeys: Array<Row> = sorted.map(({ n, s }) => {
    const open = o.journeys.find((j) => j.name === n)?.open ?? 0
    const stage = s === undefined || s.stage === "triage" ? "Triage" : inTriage(s) ? (s.worker !== undefined ? `${s.worker} · ${s.stage === "refine" ? `Refine ${doneOf(s)}` : "Re-rehearse"}` : `queued #${line.findIndex((x) => x.journey === n) + 1}`) : STAGE[s.stage]
    const waits =
      s === undefined || s.stage === "triage" ? `${open} open · waits for your Refine`
      : inTriage(s) ? (s.worker !== undefined ? `${s.proposals.filter((p) => p.status === "accepted").length} drafted · ${s.proposals.filter((p) => p.status === "skipped").length} left out` : plural(s.proposals.length, "card"))
      : s.stage === "plan" ? (s.plan !== undefined ? "plan ready: accept or refine again in Feedback" : "drafting the plan")
      : `${s.item ?? "a plan"} on the Backlog`
    return { id: n, cells: { g: s !== undefined && s.stage === "plan" && s.plan !== undefined ? "◆" : s?.stage === "planned" ? "✓" : s !== undefined && inTriage(s) ? "●" : "·", journey: n, stage, waits } }
  })
  return { summary: lines.join("\n"), workers, journeys }
}
