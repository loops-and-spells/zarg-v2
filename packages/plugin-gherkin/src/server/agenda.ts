import { Snapshot } from "@zarg/graph"
import type { AgendaItem } from "@zarg/plugin/server"
import { ARRIVES, cards, similarity, states, text, THEN } from "./model"

export const agenda = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> => {
  const all = states(snap)
  if (all.length === 0 && cards(snap).length === 0) {
    return [{
      id: "gherkin:empty",
      title: "No requirements yet",
      detail: "Describe where a user starts and their first action.",
      about: [],
      priority: 1,
    }]
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
  return items
}
