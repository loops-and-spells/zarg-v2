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
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`
const decided = (st: StageView) => st.proposals.filter((p) => p.status === "accepted" || p.status === "skipped")
const glyph = (p: P, inFlight: boolean) => (p.status === "accepted" ? (triesOf(p).length > 1 ? "↻" : "✓") : p.status === "skipped" ? "✗" : inFlight ? "⠋" : "·")
const STAGE = { triage: "Triage", refine: "Refine", rehearse: "Re-rehearse", plan: "Plan", planned: "Planned" } as const

/** The Triage Agent's view from the journeys' stages: a summary, the round's cards (each with its tries in full), the journeys. */
export const triageView = (o: {
  readonly stages: ReadonlyArray<StageView>
  readonly journeys: ReadonlyArray<{ readonly name: string; readonly open: number }>
  readonly working?: Working
  readonly now: number
  readonly paused: boolean
  /** Each drafted card's change, as a diff to show in its detail. */
  readonly diffs: Readonly<Record<string, string>>
}) => {
  const active = o.working !== undefined ? o.stages.find((s) => s.journey === o.working!.journey) : undefined
  // The round the table shows: the one being worked, else the last one with tries.
  const round = active ?? o.stages.find((s) => s.stage !== "triage" && s.stage !== "planned" && s.proposals.some((p) => triesOf(p).length > 0)) ?? o.stages.find((s) => s.proposals.some((p) => triesOf(p).length > 0)) ?? o.stages.find((s) => s.stage !== "triage" && s.stage !== "planned")
  const elapsed = o.working !== undefined ? o.now - o.working.since : 0

  const lines: Array<string> = []
  if (o.paused) lines.push("**paused** · p resumes")
  if (active !== undefined && active.stage === "refine") {
    const done = decided(active)
    // Only cards whose tries were kept say how long a card takes.
    const timed = done.filter((p) => triesOf(p).length > 0)
    const avg = sum(timed.map((p) => sum(triesOf(p).map((t) => t.ms)))) / Math.max(1, timed.length)
    const waiting = active.proposals.filter((p) => p.status === "waiting").length
    const left = timed.length > 0 ? ` · ~${Math.max(1, Math.round((avg * waiting - elapsed) / 60_000))} min left` : ""
    lines.push(`**refining ${active.journey}** · ${done.length}/${active.proposals.length} cards · ${active.proposals.filter((p) => p.status === "accepted").length} drafted · ${active.proposals.filter((p) => p.status === "accepted" && triesOf(p).length > 1).length} retried · ${done.filter((p) => p.status === "skipped").length} left out${left}`)
    const p = active.proposals.find((x) => x.card === o.working!.card)
    if (p !== undefined) lines.push("", `**${p.card}**${p.title !== undefined ? ` ${p.title}` : ""} · drafting`)
  } else if (active !== undefined && active.stage === "rehearse") {
    lines.push(`**re-rehearsing ${active.journey}** over the draft`, "", `run ${active.run ?? "starting"} · its testers are in rehearse's view`, "The result goes to Feedback: what is resolved, what is still reported, on to Plan.")
  } else {
    lines.push("**idle** · wakes when a journey is refined or a run ends")
    if (round !== undefined) {
      const done = decided(round)
      const ts = round.proposals.flatMap(triesOf)
      const timed = done.filter((p) => triesOf(p).length > 0)
      const perCard = sum(timed.map((p) => sum(triesOf(p).map((t) => t.ms)))) / Math.max(1, timed.length)
      lines.push("", `Last round · ${round.journey}: ${plural(round.proposals.length, "card")} · ${round.proposals.filter((p) => p.status === "accepted").length} drafted · ${done.filter((p) => p.status === "skipped").length} left out · ${dur(perCard)} per card · ${Math.round((sum(ts.map((t) => t.reasoning)) / Math.max(1, sum(ts.map((t) => t.tokensOut)))) * 100)}% of tokens reasoning`)
      const failed = new Map<string, number>()
      for (const p of round.proposals) for (const t of triesOf(p)) for (const why of t.problems) failed.set(why, (failed.get(why) ?? 0) + 1)
      if (failed.size > 0) lines.push("", `Why tries failed: ${[...failed].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n}× ${w}`).join(" · ")}`)
    }
  }

  const cards: Array<Row> = []
  const details: Record<string, string> = {}
  for (const p of round?.proposals ?? []) {
    const inFlight = o.working !== undefined && o.working.journey === round!.journey && o.working.card === p.card
    const ts = triesOf(p)
    const g = glyph(p, inFlight)
    cards.push({
      id: p.card,
      cells: { g, card: `gherkin/card:${p.card}` },
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
      ...(inFlight ? ["The Triage Agent is asking the model about this card now; its tries show here when it answers."] : []),
      ...(p.status === "waiting" && !inFlight ? [`Waiting its turn.${(p.problems ?? []).length > 0 ? ` Drafted again after: ${p.problems!.join("; ")}` : ""}`] : []),
      ...(p.status === "skipped" && ts.length === 0 ? [`Left out: ${(p.problems ?? []).join("; ")}`] : []),
      ...(p.status === "accepted" ? ["", p.summary, ...(o.diffs[p.card] !== undefined ? ["", o.diffs[p.card]!] : [])] : []),
      ...(p.status === "skipped" && p.changes.length > 0 ? ["", "**Proposed** (not in the draft)", ...p.changes.map((c) => `- ${c.tool} ${JSON.stringify(c.params)}`)] : []),
      ...(p.status !== "waiting" ? ["", "d drafts it again, with what failed passed to the model."] : []),
    ].join("\n")
  }

  const journeys: Array<Row> = o.journeys.map((j) => {
    const st = o.stages.find((s) => s.journey === j.name)
    const stage = st?.stage ?? "triage"
    const busy = o.working?.journey === j.name
    const waits =
      stage === "triage" ? `${j.open} open · waits for your Refine`
      : stage === "refine" ? `${decided(st!).length}/${st!.proposals.length} cards`
      : stage === "rehearse" ? `run ${st!.run ?? "starting"}`
      : stage === "plan" ? (st!.plan !== undefined ? "plan ready: accept or refine again in Feedback" : "drafting the plan")
      : `${st!.item ?? "a plan"} on the Backlog`
    return { id: j.name, ...(busy ? { busy: true as const } : {}), cells: { g: busy ? "⠋" : stage === "plan" && st!.plan !== undefined ? "◆" : stage === "planned" ? "✓" : "·", journey: j.name, stage: STAGE[stage], waits } }
  })
  return { summary: lines.join("\n"), cards, details, journeys }
}
