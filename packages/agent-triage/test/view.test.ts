import { describe, expect, test } from "bun:test"
import { dur, rollupView, workerView } from "../src/view"

const t = (ms: number, out: number, reasoning: number, problems: ReadonlyArray<string> = [], finish = "stop") => ({ ms, tokensIn: 5200, tokensOut: out, reasoning, finish, problems })
const round = {
  journey: "Talk with zarg",
  stage: "refine" as const,
  draft: [{ tool: "edit-card", params: {} }],
  proposals: [
    { card: "UX-0071", title: "Driver Agent chooses for the operator", status: "accepted" as const, summary: "the operator confirms", changes: [{ tool: "edit-card", params: { id: "UX-0071" } }], answers: [], tries: [t(41_000, 1800, 1100)] },
    { card: "UX-0077", title: "Operator sees a diagram", status: "accepted" as const, summary: "one card per case", changes: [], answers: [], tries: [t(30_000, 1500, 900, ["a clause has if"]), t(50_000, 1800, 1200)] },
    { card: "UX-0012", title: "Operator chats about the question", status: "skipped" as const, summary: "", changes: [], answers: [], problems: ["6 thens"], tries: [t(180_000, 16384, 16384, ["the model gave no answer"], "length"), t(70_000, 4900, 3400, ["6 thens"])] },
    { card: "UX-0017", title: "Driver Agent merges compatible edits", status: "waiting" as const, summary: "", changes: [], answers: [] },
    { card: "UX-0010", status: "waiting" as const, summary: "", changes: [], answers: [] },
  ],
}
const journeys = [{ name: "Talk with zarg", open: 68 }, { name: "Reconcile", open: 57 }]

describe("the Triage Agent's view", () => {
  test("working: the round's counts and time left; the card in flight; each card's outcome, time, tokens, think and why", () => {
    const v = workerView({ stage: round, working: { journey: "Talk with zarg", card: "UX-0017", since: 1_000 }, now: 39_000, diffs: {} })
    expect(v.summary).toContain("**refining Talk with zarg**")
    expect(v.summary).toContain("3/5 cards · 2 drafted · 1 retried · 1 left out · ~3 min left")
    // The view redraws only when the agent pushes: no spinner, no running clock.
    expect(v.summary).toContain("**UX-0017** Driver Agent merges compatible edits · drafting")
    expect(v.summary).not.toContain("38 s")
    // The table is the outcome and the card; the rest is in the detail.
    expect(v.cards.map((r) => [r.cells.g, r.id, Object.keys(r.cells)])).toEqual([
      ["✓", "UX-0071", ["g", "card"]],
      ["↻", "UX-0077", ["g", "card"]],
      ["✗", "UX-0012", ["g", "card"]],
      ["⠋", "UX-0017", ["g", "card"]],
      ["·", "UX-0010", ["g", "card"]],
    ])
    expect(v.cards[2]!.tone).toBe("error")
    // The card in flight spins in the shell.
    expect(v.cards.map((r) => r.busy === true)).toEqual([false, false, false, true, false])
    expect(v.details["UX-0017"]).toContain("Asking the model about this card now")
    expect(v.details["UX-0010"]).toContain("Waiting its turn")
    expect(v.cards[0]!.cells.card).toBe("gherkin/card:UX-0071")
  })
  test("a card's detail: each try (time, tokens, how it ended, what was wrong), then its change", () => {
    const v = workerView({ stage: round, now: 0, diffs: { "UX-0071": "```diff\n- When a\n+ When b\n```" } })
    expect(v.details["UX-0012"]).toContain("**UX-0012** Operator chats about the question · left out")
    expect(v.details["UX-0012"]).toContain("2 tries · 4 m 10 s · 10.4k → 21.3k tokens")
    expect(v.details["UX-0012"]).toContain("✗ try 1 · 3 m 00 s · 5.2k → 16.4k · 16.4k reasoning · stopped at the token limit")
    expect(v.details["UX-0012"]).toContain("  the model gave no answer")
    expect(v.details["UX-0012"]).toContain("▮▮▮▮▮▮ reasoning")
    // Left out before tries were kept: its problems still show.
    const old = workerView({ stage: { ...round, proposals: [{ card: "UX-0018", status: "skipped" as const, summary: "", changes: [], answers: [], problems: ["the Triage Agent could not draft a proposal"] }] }, now: 0, diffs: {} })
    expect(old.details["UX-0018"]).toContain("Left out: the Triage Agent could not draft a proposal")
    expect(v.details["UX-0071"]).toContain("```diff\n- When a\n+ When b\n```")
  })
  test("re-rehearsing: one line for the run", () => {
    const v = workerView({ stage: { ...round, stage: "rehearse", run: "r-4c1a" }, working: { journey: "Talk with zarg", card: "", since: 0 }, now: 720_000, diffs: {} })
    expect(v.summary).toContain("**re-rehearsing Talk with zarg** over the draft")
    expect(v.summary).toContain("run r-4c1a · its testers are in rehearse's view")
  })
  test("the rollup: how many workers are busy, each worker's journey and progress, the journeys in line", () => {
    const queued = { ...round, journey: "Reconcile", queued: 2, proposals: [{ card: "UX-0030", status: "waiting" as const, summary: "", changes: [], answers: [] }] }
    const planned = { ...round, journey: "Set up", stage: "plan" as const, plan: { title: "t", steps: [] } }
    const v = rollupView({
      stages: [{ ...round, queued: 1, worker: "triage-1" }, queued, planned],
      journeys: [...journeys, { name: "Set up", open: 53 }, { name: "Watch agents", open: 11 }],
      workers: [{ id: "triage-1", journey: "Talk with zarg", working: { journey: "Talk with zarg", card: "UX-0017", since: 0 } }, { id: "triage-2" }],
      paused: false,
    })
    expect(v.summary).toContain("**1 of 2 workers busy** · 1 queued")
    expect(v.workers.map((r) => [r.id, r.cells.journey, r.cells.now, r.busy === true])).toEqual([
      ["triage-1", "Talk with zarg", "Refine 3/5 cards · UX-0017", true],
      ["triage-2", "", "free", false],
    ])
    expect(v.journeys.map((r) => [r.id, r.cells.stage, r.cells.waits])).toEqual([
      ["Talk with zarg", "triage-1 · Refine 3/5 cards", "2 drafted · 1 left out"],
      ["Reconcile", "queued #1", "1 card"],
      ["Set up", "Plan", "plan ready: accept or refine again in Feedback"],
      ["Watch agents", "Triage", "11 open · waits for your Refine"],
    ])
    expect(v.journeys[2]!.cells.g).toBe("◆")
  })
  test("paused says so, and how to resume", () => {
    expect(rollupView({ stages: [round], journeys, workers: [{ id: "triage-1" }], paused: true }).summary).toContain("**paused** · p resumes")
  })
  test("durations read as seconds, then minutes and seconds", () => {
    expect([dur(900), dur(38_000), dur(80_000), dur(3_600_000)]).toEqual(["1 s", "38 s", "1 m 20 s", "60 m 00 s"])
  })
  test("time left averages only the cards whose tries were kept", () => {
    const early = { card: "UX-0018", status: "skipped" as const, summary: "", changes: [], answers: [], problems: ["no proposal"] }
    const v = workerView({ stage: { ...round, proposals: [early, ...round.proposals] }, working: { journey: "Talk with zarg", card: "UX-0017", since: 0 }, now: 0, diffs: {} })
    // (41 + 80 + 250 s) / 3 cards ≈ 124 s each, 2 waiting: ~4 min.
    expect(v.summary).toContain("~4 min left")
  })
})
