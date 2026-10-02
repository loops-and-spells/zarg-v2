import { Schema } from "effect"
import { type Node, Snapshot } from "@zarg/graph/pure"

export const STATE = "gherkin/state"
export const SCENARIO = "gherkin/scenario"
export const ARRIVES = "gherkin/arrives"
export const GIVEN = "gherkin/given"
export const THEN = "gherkin/then"

export const StateProps = Schema.Struct({
  text: Schema.NonEmptyString,
  /** A state the user can start from; no scenario needs to lead here. */
  entry: Schema.optionalKey(Schema.Boolean),
  /** A final outcome; no scenario needs to continue from here. */
  terminal: Schema.optionalKey(Schema.Boolean),
})

export const ScenarioProps = Schema.Struct({
  title: Schema.NonEmptyString,
  when: Schema.NonEmptyString,
})

export const text = (n: Node): string => String(n.props.text ?? "")

/** Lowercase, single spaces, no trailing period: the form used to compare state text. */
export const normalize = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ").replace(/\.$/, "")

export const states = (snap: Snapshot.Snapshot) => Snapshot.byType(snap, STATE)
export const scenarios = (snap: Snapshot.Snapshot) => Snapshot.byType(snap, SCENARIO)

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

export const PERSONA = "gherkin/persona"
export const BY = "gherkin/by"

export const PersonaProps = Schema.Struct({
  /** Short and unique; the prefix of its scenarios' titles ("Operator", "CLI actor", "Driver Agent"). */
  name: Schema.NonEmptyString,
  kind: Schema.Literals(["human", "cli", "agent"]),
  /** What a tester roleplays: who they are, how they reach the product, what they can and cannot see. */
  text: Schema.NonEmptyString,
})

export const personas = (snap: Snapshot.Snapshot) => Snapshot.byType(snap, PERSONA)
export const personaName = (n: Node): string => String(n.props.name ?? "")
export const findPersona = (snap: Snapshot.Snapshot, ref: { readonly id: string } | { readonly name: string }): Node | undefined => {
  if ("id" in ref) {
    const n = snap.nodes.get(ref.id)
    return n?.type === PERSONA ? n : undefined
  }
  return personas(snap).find((p) => normalize(personaName(p)) === normalize(ref.name))
}

export const JOURNEY = "gherkin/journey"
export const IN = "gherkin/in"

/** A named journey: the scenarios tagged with it (a scenario can be in several). */
export const JourneyProps = Schema.Struct({ name: Schema.NonEmptyString })

export const journeys = (snap: Snapshot.Snapshot) => Snapshot.byType(snap, JOURNEY)
export const journeyName = (n: Node): string => String(n.props.name ?? "")
export const findJourney = (snap: Snapshot.Snapshot, ref: { readonly id: string } | { readonly name: string }): Node | undefined => {
  if ("id" in ref) {
    const n = snap.nodes.get(ref.id)
    return n?.type === JOURNEY ? n : undefined
  }
  return journeys(snap).find((j) => normalize(journeyName(j)) === normalize(ref.name))
}
