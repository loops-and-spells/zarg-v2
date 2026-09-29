import { parseRef } from "@zarg/entities"
import type { Item } from "./items"
import { LANE_TITLES } from "./items"

type Fb = { readonly id: string; readonly kind: string; readonly severity: string; readonly note: string; readonly ref: string }
/** A card the plan touches: its lines now and as the plan leaves them (none before: a new card). */
export type CardDiff = { readonly id: string; readonly title: string; readonly before: ReadonlyArray<string>; readonly after: ReadonlyArray<string> }

const cardOf = (ref: string) => parseRef(ref)?.id ?? ref
/** Cards grouped by their change, in the order they first come. */
const groups = (cards: ReadonlyArray<CardDiff>, diff: (c: CardDiff) => ReadonlyArray<string>) => {
  const by = new Map<string, Array<CardDiff>>()
  for (const c of cards) {
    const k = diff(c).join("\n")
    by.set(k, [...(by.get(k) ?? []), c])
  }
  return [...by.values()]
}
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`

/** A plan for reading: what it is, what it changes card by card (only the lines that change), what feedback it closes. */
export const planText = (i: Pick<Item, "id" | "title" | "journey" | "persona" | "severity" | "status" | "cards" | "changes" | "steps">, feedback: ReadonlyArray<Fb>, cards: ReadonlyArray<CardDiff>, changed: ReadonlySet<string>): string => {
  const added = cards.filter((c) => c.before.length === 0)
  const edited = cards.filter((c) => c.before.length > 0)
  const high = feedback.filter((f) => f.severity === "high")
  const kinds = new Map<string, number>()
  for (const f of feedback) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1)
  const diff = (c: CardDiff) => [...c.before.filter((l) => !c.after.includes(l)).map((l) => `- ${l}`), ...c.after.filter((l) => !c.before.includes(l)).map((l) => `+ ${l}`)]
  return [
    `${i.id} · ${LANE_TITLES[i.status]}`,
    `**${i.title}**`,
    [i.journey, i.persona, i.severity].filter((x) => x !== undefined).join(" · "),
    `${plural(cards.length, "card")}: ${edited.length} changed, ${added.length} new · ${plural(i.changes.length, "change")} · closes ${feedback.length} feedback${high.length > 0 ? ` (${high.length} high)` : ""}`,
    ...(changed.size === 1 ? [`⚠ ${cardOf([...changed][0]!)} changed since this plan was drafted: **s** Resync`] : changed.size > 1 ? [`⚠ ${changed.size} cards changed since this plan was drafted (${[...changed].map(cardOf).join(", ")}): **s** Resync`] : []),
    ...(i.steps.length > 0 ? ["", "**The plan**", ...i.steps.map((s, k) => `${k + 1}. ${s}`)] : []),
    // Cards with the same change (a reworded state they share) show it once.
    ...(edited.length > 0 ? ["", "**Changed cards**", ...groups(edited, diff).flatMap((g) => ["", g.length === 1 ? `**${g[0]!.id}** ${g[0]!.title}` : `**${g.map((c) => c.id).join(", ")}** ${g.length} cards, the same change`, "```diff", ...diff(g[0]!), "```"])] : []),
    ...(added.length > 0 ? ["", "**New cards**", ...added.flatMap((c) => ["", `**New** ${c.title}`, "```diff", ...c.after.map((l) => `+ ${l}`), "```"])] : []),
    ...(feedback.length > 0
      ? ["", `**Feedback it closes** ${feedback.length}`, [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · "), ...(high.length > 0 ? ["", ...high.map((f) => `◇ ${cardOf(f.ref)} ${f.note}`)] : [])]
      : []),
    "",
    "Every change, card version and feedback id: the For agents tab.",
  ].join("\n")
}
