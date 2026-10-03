import type { RoundView } from "./intent"

const KIND: Readonly<Record<string, string>> = { O: "outcome", K: "constraint", J: "journey" }
/** The agent's view: a line of counts, a row per round (its latest state), each round's detail. */
export const intentView = (rounds: ReadonlyArray<RoundView>) => ({
  summary:
    rounds.length === 0
      ? "No intents yet: nothing to reconcile."
      : `**${rounds.filter((r) => r.state === "planned").length} planned** · ${rounds.filter((r) => r.state === "asked").length} asked · ${rounds.filter((r) => r.state === "left").length} left out · ${rounds.filter((r) => r.state === "drafting").length} drafting`,
  rows: rounds.map((r) => ({ id: r.id, cells: { id: `gherkin/${KIND[r.id[0]!] ?? "outcome"}:${r.id}`, state: r.state, plans: r.plans.join(", ") } })),
  details: Object.fromEntries(rounds.map((r) => [r.id, [`**${r.id}** ${r.title}`, "", r.detail || "—", ...(r.plans.length > 0 ? ["", `Plans: ${r.plans.join(", ")}`] : [])].join("\n")])),
})
