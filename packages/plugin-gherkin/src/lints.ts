import type { Node } from "@zarg/graph/pure"
import type { Finding, Lint } from "./kit"
import { CARD, JOURNEY, journeyName, journeys, normalize, PERSONA, personaName, personas, similarity, STATE, states, text } from "./model"

const MAX_WORDS = 15

const clauses = (n: Node): ReadonlyArray<string> =>
  n.type === STATE ? [text(n)] : n.type === CARD ? [String(n.props.when ?? "")] : []

const touched: (ctx: Parameters<Lint>[0]) => ReadonlyArray<Node> = ({ diff }) => [
  ...diff.added,
  ...diff.changed.map((c) => c.after),
]

/** One atomic fact per clause: short, no conditions, no "and" chaining. */
// @card C-0003
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
const words = (s: string) => s.trim().split(/\s+/).filter((w) => w !== "").length

/** A persona: a short unique name (its cards' title prefix), a roleplay text a tester can hold. */
export const personaShape: Lint = (ctx) =>
  touched(ctx)
    .filter((n) => n.type === PERSONA)
    .flatMap((n): ReadonlyArray<Finding> => {
      const out: Array<Finding> = []
      const name = personaName(n)
      if (words(name) > 4) out.push({ severity: "error", code: "persona-name-long", message: `${n.id}: "${name}" has ${words(name)} words; a persona name has at most 4 words`, about: [n.id] })
      const text = String(n.props.text ?? "")
      if (words(text) > 60) out.push({ severity: "error", code: "persona-text-long", message: `${n.id}: its text has ${words(text)} words; keep it to at most 60 words`, about: [n.id] })
      for (const o of personas(ctx.after)) {
        if (o.id !== n.id && normalize(personaName(o)) === normalize(name)) out.push({ severity: "error", code: "duplicate-persona", message: `${n.id} has the name of ${o.id} ("${personaName(o)}"); use ${o.id}`, about: [n.id, o.id] })
      }
      return out
    })

/** A journey name is unique (case does not matter). */
export const journeyShape: Lint = (ctx) =>
  touched(ctx)
    .filter((n) => n.type === JOURNEY)
    .flatMap((n): ReadonlyArray<Finding> =>
      journeys(ctx.after)
        .filter((o) => o.id !== n.id && normalize(journeyName(o)) === normalize(journeyName(n)))
        .map((o) => ({ severity: "error" as const, code: "duplicate-journey", message: `${n.id} has the name of ${o.id} ("${journeyName(o)}"); use ${o.id}`, about: [n.id, o.id] })),
    )
