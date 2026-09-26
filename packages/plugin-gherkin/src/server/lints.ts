import type { Node } from "@zarg/graph"
import type { Finding, Lint } from "@zarg/plugin/server"
import { CARD, normalize, similarity, STATE, states, text } from "./model"

const MAX_WORDS = 15

const clauses = (n: Node): ReadonlyArray<string> =>
  n.type === STATE ? [text(n)] : n.type === CARD ? [String(n.props.when ?? "")] : []

const touched: (ctx: Parameters<Lint>[0]) => ReadonlyArray<Node> = ({ diff }) => [
  ...diff.added,
  ...diff.changed.map((c) => c.after),
]

/** One atomic fact per clause: short, no conditions, no "and" chaining. */
// @card UX-0003
export const clauseShape: Lint = (ctx) =>
  touched(ctx).flatMap((n) =>
    clauses(n).flatMap((c): ReadonlyArray<Finding> => {
      const out: Array<Finding> = []
      const count = c.trim().split(/\s+/).length
      if (count > MAX_WORDS) {
        out.push({ severity: "error", code: "clause-too-long", message: `${n.id}: "${c}" has ${count} words; keep clauses to ${MAX_WORDS} or fewer`, about: [n.id] })
      }
      if (/\bif\b/i.test(c)) {
        out.push({ severity: "error", code: "conditional", message: `${n.id}: "${c}" contains "if"; make one card per case instead`, about: [n.id] })
      }
      if (/\band\b/i.test(c)) {
        out.push({ severity: "warn", code: "and-chaining", message: `${n.id}: "${c}" contains "and"; split it if it states two facts`, about: [n.id] })
      }
      return out
    }),
  )

/** State text must be unique; near-identical text is probably the same state. */
export const stateText: Lint = (ctx) =>
  touched(ctx)
    .filter((n) => n.type === STATE)
    .flatMap((n): ReadonlyArray<Finding> =>
      states(ctx.after)
        .filter((o) => o.id !== n.id)
        .flatMap((o): ReadonlyArray<Finding> => {
          if (normalize(text(o)) === normalize(text(n))) {
            return [{ severity: "error", code: "duplicate-state", message: `${n.id} repeats the text of ${o.id}; reuse ${o.id}`, about: [n.id, o.id] }]
          }
          if (similarity(text(o), text(n)) >= 0.8) {
            return [{ severity: "warn", code: "near-duplicate-state", message: `${n.id} "${text(n)}" is close to ${o.id} "${text(o)}"; merge them if they mean the same`, about: [n.id, o.id] }]
          }
          return []
        }),
    )
