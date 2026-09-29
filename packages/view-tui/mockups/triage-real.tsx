// THROWAWAY: the real renderer drawing the Triage Agent's view from triageView's output.
import { testRender } from "@opentui/react/test-utils"
import { layoutOf, startUi } from "@zarg/view"
import { AgentView } from "../src/sections"

import { triageView } from "../../agent-triage/src/view"
import { TriageView } from "../../agent-triage/src/views"

const t = (ms: number, out: number, reasoning: number, problems: ReadonlyArray<string> = [], finish = "stop") => ({ ms, tokensIn: 5200, tokensOut: out, reasoning, finish, problems })
const st = { journey: "Talk with zarg", stage: "refine" as const, draft: [], proposals: [
  { card: "UX-0071", title: "Driver Agent chooses for the operator", status: "accepted" as const, summary: "the operator confirms; the saved answer carries option and reason", changes: [], answers: [], tries: [t(41_000, 1800, 1100)] },
  { card: "UX-0077", title: "Operator sees a diagram", status: "accepted" as const, summary: "one card per case", changes: [], answers: [], tries: [t(30_000, 1500, 900, ["a clause has if"]), t(50_000, 1800, 1200)] },
  { card: "UX-0012", title: "Operator chats about the question", status: "skipped" as const, summary: "", changes: [], answers: [], problems: ["UX-0012 would have 6 thens; it needs 1-5"], tries: [t(180_000, 16384, 16384, ["the model gave no answer"], "length"), t(70_000, 4900, 3400, ["UX-0012 would have 6 thens; it needs 1-5"])] },
  { card: "UX-0017", title: "Driver Agent merges compatible edits", status: "waiting" as const, summary: "", changes: [], answers: [] },
  { card: "UX-0010", status: "waiting" as const, summary: "", changes: [], answers: [] },
] }
const v = triageView({ stages: [st], journeys: [{ name: "Talk with zarg", open: 68 }, { name: "Reconcile", open: 57 }], working: { journey: "Talk with zarg", card: "UX-0017", since: 0 }, now: 38_000, paused: false, diffs: { "UX-0071": "```diff\n- When  the conversation settles on one option\n+ When  the operator confirms one option\n  Then  the chosen option is shown with its reason\n```" } })
const view = { agent: "triage:triage", layout: layoutOf(TriageView), data: { summary: { markdown: v.summary }, cards: { rows: v.cards }, detail: { markdown: "", rows: v.details }, journeys: { rows: v.journeys } } }
const ui = { ...startUi(view as never), rows: { cards: 3 } }
const r = await testRender(<AgentView view={view as never} ui={ui} height={28} width={95} />, { width: 95, height: 30, exitOnCtrlC: false, exitSignals: [] })
await r.renderOnce(); await Bun.sleep(300); await r.renderOnce()
console.log(r.captureCharFrame())
r.renderer.destroy()
