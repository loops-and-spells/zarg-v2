import { Schema } from "effect"
import { type Node, Snapshot } from "@zarg/graph"

export const STATE = "gherkin/state"
export const CARD = "gherkin/card"
export const ARRIVES = "gherkin/arrives"
export const GIVEN = "gherkin/given"
export const THEN = "gherkin/then"

export const StateProps = Schema.Struct({
  text: Schema.NonEmptyString,
  /** A state the user can start from; no card needs to lead here. */
  entry: Schema.optionalKey(Schema.Boolean),
  /** A final outcome; no card needs to continue from here. */
  terminal: Schema.optionalKey(Schema.Boolean),
})

export const CardProps = Schema.Struct({
  title: Schema.NonEmptyString,
  when: Schema.NonEmptyString,
})

export const text = (n: Node): string => String(n.props.text ?? "")

/** Lowercase, single spaces, no trailing period: the form used to compare state text. */
export const normalize = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ").replace(/\.$/, "")

export const states = (snap: Snapshot.Snapshot) => Snapshot.byType(snap, STATE)
export const cards = (snap: Snapshot.Snapshot) => Snapshot.byType(snap, CARD)

export const findStateByText = (snap: Snapshot.Snapshot, t: string): Node | undefined =>
  states(snap).find((s) => normalize(text(s)) === normalize(t))

const words = (s: string) => new Set(normalize(s).split(" "))

/** Word-set overlap in [0, 1]. */
export const similarity = (a: string, b: string): number => {
  const x = words(a)
  const y = words(b)
  const both = [...x].filter((w) => y.has(w)).length
  return both / (x.size + y.size - both)
}
