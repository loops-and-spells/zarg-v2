import { type Node, Snapshot } from "@zarg/graph/pure"
import { BOUNDS, CONSTRAINT, IN, intents, JOURNEY, journeyName, OUTCOME, QUESTION, SERVES, statementsOf, text } from "./model"
import { renderScenario } from "./render"

const GLYPH: Readonly<Record<string, string>> = { [OUTCOME]: "▸", [CONSTRAINT]: "▪", [QUESTION]: "?" }
const nameOf = (snap: Snapshot.Snapshot, id: string) => {
  const n = snap.nodes.get(id)
  return n === undefined ? id : String(n.props.name ?? n.props.title ?? id)
}

/** A statement in full: the journeys that serve it (or what it bounds), each journey's scenarios as Gherkin. */
const detailOf = (snap: Snapshot.Snapshot, s: Node, served: ReadonlyArray<string>) => {
  const head = `**${s.id}** ${text(s)}`
  if (s.type === QUESTION) return [head, "", s.props.answer !== undefined ? `**Answer** ${String(s.props.answer)}` : "Open: ⏎ answers it."].join("\n")
  const targets = s.type === OUTCOME ? served : s.edges.filter((e) => e.type === BOUNDS).map((e) => e.to)
  if (targets.length === 0) return [head, "", s.type === OUTCOME ? "No journey serves it yet." : "It bounds nothing yet."].join("\n")
  const blocks = targets.map((t) => {
    const n = snap.nodes.get(t)
    const ids = n?.type === JOURNEY ? Snapshot.inbound(snap, t, IN).map((e) => e.from).sort() : [t]
    const gherkin = ids.flatMap((id) => {
      const c = snap.nodes.get(id)
      return c === undefined ? [] : [renderScenario(snap, c)]
    })
    return [`### ${n === undefined ? t : n.type === JOURNEY ? journeyName(n) : String(n.props.title)} (${t})`, "```gherkin", gherkin.join("\n\n") || "No scenarios yet.", "```"].join("\n")
  })
  return [head, "", `**${s.type === OUTCOME ? "Served by" : "Bounds"}** ${targets.map((t) => `${nameOf(snap, t)} (${t})`).join(", ")}`, "", ...blocks].join("\n")
}

/** A plan on the Backlog serving a statement (its ref with a version). */
export type ServingPlan = { readonly id: string; readonly title: string; readonly status: string; readonly serves: string }

// @scenario S-0099
/** The Intents view's data: every intent and its statements as rows, with coverage; a detail per row, with the plans serving it. */
export const intentsView = (snap: Snapshot.Snapshot, plans: ReadonlyArray<ServingPlan> = []) => {
  const all = [...intents(snap)].sort((a, b) => a.id.localeCompare(b.id))
  const rows: Array<{ id: string; cells: { item: string; cover: string }; text: string }> = []
  const details: Record<string, string> = {}
  const servedBy = (o: string) => Snapshot.inbound(snap, o, SERVES).map((e) => e.from).sort()
  for (const i of all) {
    const own = statementsOf(snap, i.id)
    rows.push({ id: i.id, cells: { item: `◈ ${i.id} ${String(i.props.title)}`, cover: String(i.props.status) }, text: String(i.props.title) })
    details[i.id] = [`**${i.id} ${String(i.props.title)}** · ${String(i.props.status)}`, "", String(i.props.problem ?? "No problem written yet."), "", `${own.length} statement${own.length === 1 ? "" : "s"}.`].join("\n")
    for (const s of own) {
      const bounds = s.edges.filter((e) => e.type === BOUNDS).map((e) => nameOf(snap, e.to))
      const cover =
        s.type === OUTCOME ? (servedBy(s.id).length > 0 ? servedBy(s.id).map((j) => nameOf(snap, j)).join(", ") : "◇ no journey")
        : s.type === CONSTRAINT ? (bounds.length > 0 ? `bounds ${bounds.join(", ")}` : "bounds nothing")
        : s.props.answer !== undefined ? "answered" : "open"
      rows.push({ id: s.id, cells: { item: `  ${GLYPH[s.type] ?? "·"} ${text(s)}`, cover }, text: text(s) })
      details[s.id] = detailOf(snap, s, servedBy(s.id))
      const mine = plans.filter((p) => p.serves.split("@")[0] === `${s.type}:${s.id}`)
      if (mine.length > 0) details[s.id] += `\n\n**Plans**\n${mine.map((p) => `- ${p.id} ${p.status}: ${p.title}`).join("\n")}`
    }
  }
  const outcomes = all.flatMap((i) => statementsOf(snap, i.id)).filter((s) => s.type === OUTCOME)
  const uncovered = outcomes.filter((o) => servedBy(o.id).length === 0).length
  return {
    summary: {
      items: [
        { label: all.length === 1 ? "intent" : "intents", value: String(all.length) },
        { label: outcomes.length === 1 ? "outcome" : "outcomes", value: String(outcomes.length) },
        { label: "uncovered", value: String(uncovered), ...(uncovered > 0 ? { tone: "attention" as const } : {}) },
      ],
    },
    rows,
    details,
  }
}
