import { type Node, Snapshot } from "@zarg/graph/pure"
import type { Finding, Lint } from "./kit"
import { HAS, INTENT, isStatement, JOURNEY, journeyName, journeys, normalize, PERSONA, personaName, personas, SCENARIO, scenarios, similarity, STATE, states, text, THEN } from "./model"

const MAX_WORDS = 15
/** A statement (outcome, constraint, question) is one sentence of at most 20 words. */
const MAX_STATEMENT_WORDS = 20

const clauses = (n: Node): ReadonlyArray<string> =>
  n.type === STATE || isStatement(n) ? [text(n)] : n.type === SCENARIO ? [String(n.props.when ?? "")] : []

const touched: (ctx: Parameters<Lint>[0]) => ReadonlyArray<Node> = ({ diff }) => [
  ...diff.added,
  ...diff.changed.map((c) => c.after),
]

/** One atomic fact per clause: short, no conditions, no "and" chaining. */
// @scenario S-0003
export const clauseShape: Lint = (ctx) =>
  touched(ctx).flatMap((n) =>
    clauses(n).flatMap((c): ReadonlyArray<Finding> => {
      const out: Array<Finding> = []
      const count = c.trim().split(/\s+/).length
      const max = isStatement(n) ? MAX_STATEMENT_WORDS : MAX_WORDS
      if (count > max) {
        out.push({ severity: "error", code: "clause-too-long", message: isStatement(n) ? `${n.id}: "${c}" has ${count} words; keep it to ${max} or fewer` : `${n.id}: "${c}" has ${count} words; keep clauses to ${max} or fewer`, about: [n.id] })
      }
      if (/\bif\b/i.test(c)) {
        out.push({ severity: "error", code: "conditional", message: `${n.id}: "${c}" contains "if"; make one scenario per case instead`, about: [n.id] })
      }
      if (n.type === "gherkin/scenario" && c === n.props.when && /\bor\b/i.test(c)) {
        out.push({ severity: "warn", code: "alternatives", message: `${n.id}: "${c}" contains "or"; make one scenario per case when the cases lead to different outcomes`, about: [n.id] })
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

/** A persona: a short unique name (its scenarios' title prefix), a roleplay text a tester can hold. */
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

/** A scenario title is unique (case does not matter): a driver once wrote the same scenario twice. */
export const scenarioTitle: Lint = (ctx) =>
  touched(ctx)
    .filter((n) => n.type === SCENARIO)
    .flatMap((n): ReadonlyArray<Finding> =>
      scenarios(ctx.after)
        .filter((o) => o.id !== n.id && normalize(String(o.props.title ?? "")) === normalize(String(n.props.title ?? "")))
        .map((o) => ({ severity: "error" as const, code: "duplicate-scenario", message: `${n.id} has the title of ${o.id} ("${String(o.props.title)}"); change ${o.id} instead`, about: [n.id, o.id] })),
    )

/** An intent's title: at most 10 words. */
export const intentShape: Lint = (ctx) =>
  touched(ctx)
    .filter((n) => n.type === INTENT)
    .flatMap((n): ReadonlyArray<Finding> => {
      const count = words(String(n.props.title ?? ""))
      return count > 10 ? [{ severity: "error", code: "intent-title-long", message: `${n.id}: its title has ${count} words; keep it to 10 or fewer`, about: [n.id] }] : []
    })

/** Every statement belongs to exactly one intent: the touched statements, and those a touched intent claims or let go. */
export const statementOwner: Lint = (ctx) => {
  const t = touched(ctx)
  const hasTargets = (s: Snapshot.Snapshot, id: string) => (s.nodes.get(id)?.edges ?? []).filter((e) => e.type === HAS).map((e) => e.to)
  const ids = new Set([
    ...t.filter(isStatement).map((n) => n.id),
    ...t.filter((n) => n.type === INTENT).flatMap((n) => [...hasTargets(ctx.before, n.id), ...hasTargets(ctx.after, n.id)]),
  ])
  return [...ids].flatMap((id): ReadonlyArray<Finding> => {
    const n = ctx.after.nodes.get(id)
    if (n === undefined || !isStatement(n)) return []
    const owners = Snapshot.inbound(ctx.after, id, HAS).map((e) => e.from).sort()
    if (owners.length === 1) return []
    return [{ severity: "error", code: "statement-owner", message: owners.length === 0 ? `${id} belongs to no intent` : `${id} belongs to ${owners.join(", ")}; a statement belongs to exactly one intent`, about: [id, ...owners] }]
  })
}

/** The words of a clause, lowercased: what two clauses share. */
const wordSet = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w !== ""))

/** A Then states what the action brought about: one that says the When again (most of its words) is refused. */
export const thenEchoesWhen: Lint = (ctx) =>
  touched(ctx)
    .filter((n) => n.type === SCENARIO)
    .flatMap((n): ReadonlyArray<Finding> => {
      const when = wordSet(String(n.props.when ?? ""))
      if (when.size === 0) return []
      return n.edges
        .filter((e) => e.type === THEN)
        .flatMap((e) => {
          const st = ctx.after.nodes.get(e.to)
          if (st === undefined) return []
          const then = wordSet(text(st))
          const shared = [...when].filter((w) => then.has(w)).length
          return shared / when.size >= 0.8
            ? [{ severity: "error" as const, code: "then-echoes-when", message: `${n.id}: its Then "${text(st)}" says its When again; a Then states what the action brought about (what holds now)`, about: [n.id, st.id] }]
            : []
        })
    })

export const LINTS: ReadonlyArray<Lint> = [clauseShape, stateText, personaShape, journeyShape, scenarioTitle, intentShape, statementOwner, thenEchoesWhen]
