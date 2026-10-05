import { Snapshot } from "@zarg/graph/pure"
import type { AgendaItem } from "./kit"
import { ARRIVES, BY, GIVEN, intents, JOURNEY, journeyName, OUTCOME, personaName, personas, QUESTION, scenarios, SERVES, similarity, statementsOf, states, text, THEN } from "./model"

export const agenda = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> => {
  const all = states(snap)
  if (all.length === 0 && scenarios(snap).length === 0) {
    return [
      { id: "gherkin:empty", title: "No requirements yet", detail: "Describe where a user starts and their first action.", about: [], priority: 1 },
      ...personaItems(snap),
      ...intentItems(snap),
    ]
  }
  const items: Array<AgendaItem> = []
  for (const s of all) {
    // A state some scenario starts from, or uses as its context (a Given), has something happening while it holds.
    if (s.props.terminal !== true && Snapshot.inbound(snap, s.id, ARRIVES).length === 0 && Snapshot.inbound(snap, s.id, GIVEN).length === 0) {
      items.push({
        id: `gherkin:dead-end:${s.id}`,
        title: `What can the user do when "${text(s)}"?`,
        detail: `No scenario continues from ${s.id}. Add a scenario that arrives there, or mark it terminal.`,
        about: [s.id],
        priority: 2,
      })
    }
    if (s.props.entry !== true && Snapshot.inbound(snap, s.id, THEN).length === 0) {
      items.push({
        id: `gherkin:unreached:${s.id}`,
        title: `How does the user reach "${text(s)}"?`,
        detail: `No scenario leads to ${s.id}. Add a scenario whose Then is ${s.id}, or mark it an entry state.`,
        about: [s.id],
        priority: 2,
      })
    }
  }
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) {
      if (similarity(text(a), text(b)) >= 0.8) {
        items.push({
          id: `gherkin:near-duplicate:${a.id}:${b.id}`,
          title: `Are "${text(a)}" and "${text(b)}" the same state?`,
          detail: `${a.id} and ${b.id} have nearly the same text.`,
          about: [a.id, b.id],
          priority: 3,
        })
      }
    }
  }
  items.push(...personaItems(snap))
  items.push(...intentItems(snap))
  return items
}

/** Who acts: no personas yet, scenarios that name none (one item for all of them), personas no scenario names. */
const personaItems = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> => {
  const items: Array<AgendaItem> = []
  const ps = personas(snap)
  const known = ps.map((p) => `${p.id} ${personaName(p)}`).join(", ")
  if (ps.length === 0) {
    items.push({
      id: "gherkin:no-personas",
      title: "Who uses this product?",
      detail: "No personas yet. Draft them from the intents (who each is for) and the conversation (who meets the product, and the product's own agents that act in scenarios), show them with Inquire.confirm, then add each with add-persona.",
      about: [],
      priority: 1,
    })
  }
  const nobody = scenarios(snap).filter((c) => !c.edges.some((e) => e.type === BY)).map((c) => c.id)
  if (nobody.length > 0) {
    items.push({
      id: "gherkin:who-does",
      title: `Who does ${nobody.length} scenario${nobody.length === 1 ? "" : "s"}?`,
      detail: `${nobody.slice(0, 20).join(", ")}${nobody.length > 20 ? ` and ${nobody.length - 20} more` : ""} name no persona (by). Propose one persona per scenario from its title and When, show the whole mapping with Inquire.confirm, then link each with link {edge: "by", persona}. Personas: ${known || "none yet"}.`,
      about: nobody,
      priority: 2,
    })
  }
  for (const p of ps) {
    if (Snapshot.inbound(snap, p.id, BY).length === 0) {
      items.push({ id: `gherkin:unused-persona:${p.id}`, title: `Nobody acts as ${personaName(p)}`, detail: `No scenario names ${p.id}. Link scenarios to it with link {edge: "by"}, or remove it.`, about: [p.id], priority: 3 })
    }
  }
  return items
}

/**
 * Failure candidates, when the agenda is empty: states the user can leave in only one way, busiest first (most
 * scenarios lead there). Most such steps cannot fail; the core keeps only those a decision model judges can.
 */
export const suggest = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> =>
  states(snap)
    .flatMap((s) => {
      const out = Snapshot.inbound(snap, s.id, ARRIVES)
      if (out.length !== 1) return []
      const scenario = snap.nodes.get(out[0]!.from)
      if (scenario === undefined) return []
      return [{ s, scenario, reached: Snapshot.inbound(snap, s.id, THEN).length }]
    })
    .sort((a, b) => b.reached - a.reached || a.s.id.localeCompare(b.s.id))
    .map(({ s, scenario }, i) => ({
      id: `gherkin:one-way:${s.id}`,
      title: `A failure case for "${String(scenario.props.title ?? scenario.id)}"`,
      detail: `${scenario.id} is the only way on from ${s.id}. Given ${text(s)}. When ${String(scenario.props.when ?? "")}. Then ${scenario.edges
        .filter((e) => e.type === THEN)
        .map((e) => { const t = snap.nodes.get(e.to); return t === undefined ? e.to : text(t) })
        .join(", and ")}. Can it fail or go another way the user must handle?`,
      about: [s.id, scenario.id],
      priority: i + 1,
    }))

/** Outcomes no journey serves and journeys serving none (one item each, never one per node), open questions, intents without outcomes. */
const intentItems = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> => {
  const items: Array<AgendaItem> = []
  const outcomes = Snapshot.byType(snap, OUTCOME)
  const uncovered = outcomes.filter((o) => Snapshot.inbound(snap, o.id, SERVES).length === 0)
  if (uncovered.length > 0)
    items.push({
      id: "gherkin:uncovered",
      title: `Which journey delivers ${uncovered.length} outcome${uncovered.length === 1 ? "" : "s"}?`,
      detail: `${uncovered.slice(0, 20).map((o) => `${o.id} "${text(o)}"`).join(", ")}${uncovered.length > 20 ? ` and ${uncovered.length - 20} more` : ""}: no journey serves them. Link a journey with link {edge: "serves", journey, outcome}, or shape a new journey for it.`,
      about: uncovered.map((o) => o.id),
      priority: 2,
    })
  // A journey serves nothing only once there are outcomes to serve.
  const unserving = outcomes.length === 0 ? [] : Snapshot.byType(snap, JOURNEY).filter((j) => !j.edges.some((e) => e.type === SERVES))
  if (unserving.length > 0)
    items.push({
      id: "gherkin:unserving",
      title: `What do ${unserving.length} journey${unserving.length === 1 ? "" : "s"} serve?`,
      detail: `${unserving.map((j) => `${j.id} ${journeyName(j)}`).join(", ")} serve no outcome. Link each with link {edge: "serves", journey, outcome}, or ask whether it still belongs.`,
      about: unserving.map((j) => j.id),
      priority: 3,
    })
  for (const q of Snapshot.byType(snap, QUESTION))
    if (q.props.answer === undefined) items.push({ id: `gherkin:question:${q.id}`, title: text(q), detail: `${q.id} is open. Answer it with answer-question (as an outcome or a constraint when it decides one).`, about: [q.id], priority: 2 })
  for (const i of intents(snap))
    if (!statementsOf(snap, i.id).some((s) => s.type === OUTCOME)) items.push({ id: `gherkin:no-outcome:${i.id}`, title: `What should "${String(i.props.title)}" achieve?`, detail: `${i.id} has no outcome yet. Add one with add-outcome.`, about: [i.id], priority: 2 })
  return items
}
