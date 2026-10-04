import type { Evidence } from "@zarg/evidence-capture"
import type { FiledEntry, ItemData, PlanParams } from "@zarg/plugin-backlog/contract"

type Files = Record<string, string>
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const id8 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 8)

/** Project files a journey starts from (`journey(id, { seed })`), as the product writes them. */
export const seed = {
  /** Feedback entries as the backlog keeps them: one file each, the agent's first call. */
  feedback: (entries: ReadonlyArray<FiledEntry>): Files =>
    Object.fromEntries(
      entries.map((f) => {
        const id = `F-${id8(`${f.ref}\n${f.kind}\n${f.note}`)}`
        return [`.zarg/feedback/${id}.json`, json({ ...f, id, count: 1, runs: [`${f.from.agent}:${f.from.run}`], triage: { ...f.triage, by: "agent" } })]
      }),
    ),
  /** A plan in its lane. */
  plan: (p: PlanParams & { readonly id: string; readonly status: (typeof ItemData.Type)["status"] }): Files => ({ [`.zarg/backlog/${p.id}.json`]: json({ ...p, events: [] }) }),
  /** A scenario's evidence and its media (paths relative to `.zarg/evidence`). */
  evidence: (e: Evidence, media: Readonly<Record<string, string>> = {}): Files => ({
    [`.zarg/evidence/${e.scenario}.json`]: json(e),
    ...Object.fromEntries(Object.entries(media).map(([p, t]) => [`.zarg/evidence/${p}`, t])),
  }),
}
