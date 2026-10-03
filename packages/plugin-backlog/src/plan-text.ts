import { parseRef } from "@zarg/entities"
import type { Item } from "./items"
import { LANE_TITLES } from "./items"

type Fb = { readonly id: string; readonly kind: string; readonly severity: string; readonly note: string; readonly ref: string }
/** A scenario the plan touches: its lines now and as the plan leaves them (none before: a new scenario). */
export type ScenarioDiff = { readonly id: string; readonly title: string; readonly before: ReadonlyArray<string>; readonly after: ReadonlyArray<string> }

const scenarioOf = (ref: string) => parseRef(ref)?.id ?? ref
/** Scenarios grouped by their change, in the order they first come. */
const groups = (scenarios: ReadonlyArray<ScenarioDiff>, diff: (c: ScenarioDiff) => ReadonlyArray<string>) => {
  const by = new Map<string, Array<ScenarioDiff>>()
  for (const c of scenarios) {
    const k = diff(c).join("\n")
    by.set(k, [...(by.get(k) ?? []), c])
  }
  return [...by.values()]
}
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`

/** A plan for reading: what it is, what it changes scenario by scenario (only the lines that change), what feedback it closes. */
export const planText = (i: Pick<Item, "id" | "title" | "journey" | "persona" | "severity" | "status" | "scenarios" | "changes" | "steps" | "serves">, feedback: ReadonlyArray<Fb>, scenarios: ReadonlyArray<ScenarioDiff>, changed: ReadonlySet<string>, links: { readonly after: ReadonlyArray<string>; readonly before: ReadonlyArray<string> } = { after: [], before: [] }): string => {
  const added = scenarios.filter((c) => c.before.length === 0)
  const edited = scenarios.filter((c) => c.before.length > 0)
  const high = feedback.filter((f) => f.severity === "high")
  const kinds = new Map<string, number>()
  for (const f of feedback) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1)
  const diff = (c: ScenarioDiff) => [...c.before.filter((l) => !c.after.includes(l)).map((l) => `- ${l}`), ...c.after.filter((l) => !c.before.includes(l)).map((l) => `+ ${l}`)]
  return [
    `${i.id} · ${LANE_TITLES[i.status]}`,
    `**${i.title}**`,
    ...(i.serves !== undefined ? [`Serves ${parseRef(i.serves)?.id ?? i.serves}`] : []),
    [i.journey, i.persona, i.severity].filter((x) => x !== undefined).join(" · "),
    `${plural(scenarios.length, "scenario")}: ${edited.length} changed, ${added.length} new · ${plural(i.changes.length, "change")} · closes ${feedback.length} feedback${high.length > 0 ? ` (${high.length} high)` : ""}`,
    ...(links.after.length > 0 || links.before.length > 0 ? [[...(links.after.length > 0 ? [`Waits on ${links.after.join(", ")}`] : []), ...(links.before.length > 0 ? [`${links.before.join(", ")} ${links.before.length === 1 ? "waits" : "wait"} on this`] : [])].join(" · ")] : []),
    ...(changed.size === 1 ? [`⚠ ${scenarioOf([...changed][0]!)} changed since this plan was drafted: **s** Resync`] : changed.size > 1 ? [`⚠ ${changed.size} scenarios changed since this plan was drafted (${[...changed].map(scenarioOf).join(", ")}): **s** Resync`] : []),
    ...((i as { kind?: string }).kind === "code" ? ["", "**A code change.** The scenario stays as it is: change the code so it does what the scenario says (zarg-implement, or by hand), then move this plan to Done."] : []),
    ...(i.steps.length > 0 ? ["", "**The plan**", ...i.steps.map((s, k) => `${k + 1}. ${s}`)] : []),
    // Scenarios with the same change (a reworded state they share) show it once.
    ...(edited.length > 0 ? ["", "**Changed scenarios**", ...groups(edited, diff).flatMap((g) => ["", g.length === 1 ? `**${g[0]!.id}** ${g[0]!.title}` : `**${g.map((c) => c.id).join(", ")}** ${g.length} scenarios, the same change`, "```diff", ...diff(g[0]!), "```"])] : []),
    ...(added.length > 0 ? ["", "**New scenarios**", ...added.flatMap((c) => ["", `**New** ${c.title}`, "```diff", ...c.after.map((l) => `+ ${l}`), "```"])] : []),
    ...(feedback.length > 0
      ? ["", `**Feedback it closes** ${feedback.length}`, [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · "), ...(high.length > 0 ? ["", ...high.map((f) => `◇ ${scenarioOf(f.ref)} ${f.note}`)] : [])]
      : []),
    "",
    "Every change, scenario version and feedback id: the For agents tab.",
  ].join("\n")
}
