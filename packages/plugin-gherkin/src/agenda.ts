import { Snapshot } from "@zarg/graph/pure"
import type { AgendaItem } from "./kit"
import { ARRIVES, BY, cards, personaName, personas, similarity, states, text, THEN } from "./model"

export const agenda = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> => {
  const all = states(snap)
  if (all.length === 0 && cards(snap).length === 0) {
    return [
      { id: "gherkin:empty", title: "No requirements yet", detail: "Describe where a user starts and their first action.", about: [], priority: 1 },
      ...personaItems(snap),
    ]
  }
  const items: Array<AgendaItem> = []
  for (const s of all) {
    if (s.props.terminal !== true && Snapshot.inbound(snap, s.id, ARRIVES).length === 0) {
      items.push({
        id: `gherkin:dead-end:${s.id}`,
        title: `What can the user do when "${text(s)}"?`,
        detail: `No card continues from ${s.id}. Add a card that arrives there, or mark it terminal.`,
        about: [s.id],
        priority: 2,
      })
    }
    if (s.props.entry !== true && Snapshot.inbound(snap, s.id, THEN).length === 0) {
      items.push({
        id: `gherkin:unreached:${s.id}`,
        title: `How does the user reach "${text(s)}"?`,
        detail: `No card leads to ${s.id}. Add a card whose Then is ${s.id}, or mark it an entry state.`,
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
  return items
}

/** Who acts: no personas yet, cards that name none (one item for all of them), personas no card names. */
const personaItems = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> => {
  const items: Array<AgendaItem> = []
  const ps = personas(snap)
  const known = ps.map((p) => `${p.id} ${personaName(p)}`).join(", ")
  if (ps.length === 0) {
    items.push({
      id: "gherkin:no-personas",
      title: "Who uses this product?",
      detail: "No personas yet. Draft them from the intents' frontmatter personas and the conversation (who meets the product, and the product's own agents that act in cards), show them with Inquire.confirm, then add each with add-persona.",
      about: [],
      priority: 1,
    })
  }
  const nobody = cards(snap).filter((c) => !c.edges.some((e) => e.type === BY)).map((c) => c.id)
  if (nobody.length > 0) {
    items.push({
      id: "gherkin:who-does",
      title: `Who does ${nobody.length} card${nobody.length === 1 ? "" : "s"}?`,
      detail: `${nobody.slice(0, 20).join(", ")}${nobody.length > 20 ? ` and ${nobody.length - 20} more` : ""} name no persona (by). Propose one persona per card from its title and When, show the whole mapping with Inquire.confirm, then link each with link {edge: "by", persona}. Personas: ${known || "none yet"}.`,
      about: nobody,
      priority: 2,
    })
  }
  for (const p of ps) {
    if (Snapshot.inbound(snap, p.id, BY).length === 0) {
      items.push({ id: `gherkin:unused-persona:${p.id}`, title: `Nobody acts as ${personaName(p)}`, detail: `No card names ${p.id}. Link cards to it with link {edge: "by"}, or remove it.`, about: [p.id], priority: 3 })
    }
  }
  return items
}

/**
 * Failure candidates, when the agenda is empty: states the user can leave in only one way, busiest first (most
 * cards lead there). Most such steps cannot fail; the core keeps only those a decision model judges can.
 */
export const suggest = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> =>
  states(snap)
    .flatMap((s) => {
      const out = Snapshot.inbound(snap, s.id, ARRIVES)
      if (out.length !== 1) return []
      const card = snap.nodes.get(out[0]!.from)
      if (card === undefined) return []
      return [{ s, card, reached: Snapshot.inbound(snap, s.id, THEN).length }]
    })
    .sort((a, b) => b.reached - a.reached || a.s.id.localeCompare(b.s.id))
    .map(({ s, card }, i) => ({
      id: `gherkin:one-way:${s.id}`,
      title: `A failure case for "${String(card.props.title ?? card.id)}"`,
      detail: `${card.id} is the only way on from ${s.id}. Given ${text(s)}. When ${String(card.props.when ?? "")}. Then ${card.edges
        .filter((e) => e.type === THEN)
        .map((e) => { const t = snap.nodes.get(e.to); return t === undefined ? e.to : text(t) })
        .join(", and ")}. Can it fail or go another way the user must handle?`,
      about: [s.id, card.id],
      priority: i + 1,
    }))
