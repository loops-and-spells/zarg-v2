import { Effect, Schema } from "effect"
import { type Change, type Node, Put, Remove, Snapshot } from "@zarg/graph/pure"
import { tool, ToolError } from "./kit"
import { ARRIVES, BY, CARD, findJourney, findPersona, findStateByText, GIVEN, IN, JOURNEY, journeyName, journeys, PERSONA, personaName, personas, STATE, THEN } from "./model"

/** Point at an existing state by id, or describe one by text (reused if the text already exists). */
const StateRef = Schema.Union([Schema.Struct({ id: Schema.String }), Schema.Struct({ text: Schema.NonEmptyString })]).annotate({
  description: "An existing state by {id}, or a sentence by {text} (existing text is reused).",
})
type StateRef = typeof StateRef.Type

const EdgeName = Schema.Literals(["arrives", "given", "then", "by", "in"])
const edgeType = { arrives: ARRIVES, given: GIVEN, then: THEN, by: BY, in: IN } as const

/** A journey by {id} or by {name} (case does not matter). */
const JourneyRef = Schema.Union([Schema.Struct({ id: Schema.String }), Schema.Struct({ name: Schema.NonEmptyString })]).annotate({
  description: "A journey by {id}, or by {name}.",
})
type JourneyRef = typeof JourneyRef.Type
const knownJourneys = (snap: Snapshot.Snapshot) => journeys(snap).map((j) => `${j.id} ${journeyName(j)}`).join(", ") || "none yet (add one with add-journey)"
const journeyOf = (snap: Snapshot.Snapshot, ref: JourneyRef): Effect.Effect<string, ToolError> => {
  const n = findJourney(snap, ref)
  return n !== undefined ? Effect.succeed(n.id) : Effect.fail(new ToolError({ message: `${"id" in ref ? ref.id : `"${ref.name}"`} is not a journey; known: ${knownJourneys(snap)}` }))
}
const JourneyName = Schema.NonEmptyString.annotate({ description: "Unique (case does not matter)." })

/** A persona by {id} or by {name} (case does not matter). */
const PersonaRef = Schema.Union([Schema.Struct({ id: Schema.String }), Schema.Struct({ name: Schema.NonEmptyString })]).annotate({
  description: "A persona by {id}, or by {name}.",
})
type PersonaRef = typeof PersonaRef.Type
const known = (snap: Snapshot.Snapshot) => personas(snap).map((p) => `${p.id} ${personaName(p)}`).join(", ") || "none yet (add one with add-persona)"
const personaOf = (snap: Snapshot.Snapshot, ref: PersonaRef): Effect.Effect<string, ToolError> => {
  const n = findPersona(snap, ref)
  return n !== undefined ? Effect.succeed(n.id) : Effect.fail(new ToolError({ message: `${"id" in ref ? ref.id : `"${ref.name}"`} is not a persona; known: ${known(snap)}` }))
}
const PersonaFields = {
  name: Schema.NonEmptyString.annotate({ description: "Short and unique, at most 4 words; its cards' titles start with it." }),
  kind: Schema.Literals(["human", "cli", "agent"]).annotate({ description: "human, cli (a coding agent at the command line) or agent (the product's own)." }),
  text: Schema.NonEmptyString.annotate({ description: "1-3 sentences a tester roleplays: who they are, how they reach the product, what they can and cannot see." }),
}

/** Resolves refs against a working snapshot, creating new states as needed. */
const resolver = (snap: Snapshot.Snapshot) => {
  let working = snap
  const created: Array<Node> = []
  const resolve = (ref: StateRef): Effect.Effect<string, ToolError> => {
    if ("id" in ref) {
      const n = working.nodes.get(ref.id)
      return n?.type === STATE ? Effect.succeed(ref.id) : Effect.fail(new ToolError({ message: `${ref.id} is not a state` }))
    }
    const existing = findStateByText(working, ref.text)
    if (existing !== undefined) return Effect.succeed(existing.id)
    const node: Node = { id: Snapshot.nextId(working, "S"), type: STATE, props: { text: ref.text }, edges: [] }
    created.push(node)
    working = Snapshot.applyChanges(working, [Put(node)])
    return Effect.succeed(node.id)
  }
  return { resolve, created, next: (prefix: string) => Snapshot.nextId(working, prefix) }
}

const getNode = (snap: Snapshot.Snapshot, id: string, type: string) => {
  const n = snap.nodes.get(id)
  return n?.type === type ? Effect.succeed(n) : Effect.fail(new ToolError({ message: `${id} is not a ${type}` }))
}

const createdNote = (created: ReadonlyArray<Node>) =>
  created.length === 0 ? "" : `; new states ${created.map((s) => s.id).join(", ")}`

export const addState = tool({
  name: "add-state",
  description: "Add a state (a Given/Then sentence). Fails if a state with the same text exists.",
  params: Schema.Struct({
    text: Schema.NonEmptyString.annotate({ description: "One Given/Then sentence, at most 15 words, no \"if\"." }),
    entry: Schema.optionalKey(Schema.Boolean).annotate({ description: "The user can start here." }),
    terminal: Schema.optionalKey(Schema.Boolean).annotate({ description: "Nothing needs to follow this state." }),
  }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const existing = findStateByText(snap, p.text)
      if (existing !== undefined) return yield* new ToolError({ message: `${existing.id} already has this text; use it` })
      const id = Snapshot.nextId(snap, "S")
      return { changes: [Put({ id, type: STATE, props: { ...p }, edges: [] })], message: `created ${id}` }
    }),
})

// @card UX-0004
export const editState = tool({
  name: "edit-state",
  description: "Reword a state or change its entry/terminal flags. Every card using it updates.",
  params: Schema.Struct({
    id: Schema.String,
    text: Schema.optionalKey(Schema.NonEmptyString),
    entry: Schema.optionalKey(Schema.Boolean),
    terminal: Schema.optionalKey(Schema.Boolean),
  }),
  run: ({ id, ...patch }, snap) =>
    Effect.map(getNode(snap, id, STATE), (n) => ({
      changes: [Put({ ...n, props: { ...n.props, ...patch } })],
      message: `updated ${id}`,
    })),
})

export const addPersona = tool({
  name: "add-persona",
  description: "Add a persona: someone who acts in cards (the operator, a CLI actor, an agent).",
  params: Schema.Struct(PersonaFields),
  run: (p, snap) =>
    Effect.gen(function* () {
      const existing = findPersona(snap, { name: p.name })
      if (existing !== undefined) return yield* new ToolError({ message: `${existing.id} is already called "${personaName(existing)}"; use it` })
      const id = Snapshot.nextId(snap, "P")
      return { changes: [Put({ id, type: PERSONA, props: { ...p }, edges: [] })], message: `created ${id}` }
    }),
})

export const editPersona = tool({
  name: "edit-persona",
  description: "Rename a persona, or change its kind or text.",
  params: Schema.Struct({ id: Schema.String, name: Schema.optionalKey(PersonaFields.name), kind: Schema.optionalKey(PersonaFields.kind), text: Schema.optionalKey(PersonaFields.text) }),
  run: ({ id, ...patch }, snap) => Effect.map(getNode(snap, id, PERSONA), (n) => ({ changes: [Put({ ...n, props: { ...n.props, ...patch } })], message: `updated ${id}` })),
})

export const addJourney = tool({
  name: "add-journey",
  description: "Add a journey: a name cards can be tagged with (link {edge: \"in\"}); a card can be in several.",
  params: Schema.Struct({ name: JourneyName }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const existing = findJourney(snap, { name: p.name })
      if (existing !== undefined) return yield* new ToolError({ message: `${existing.id} is already called "${journeyName(existing)}"; use it` })
      const id = Snapshot.nextId(snap, "J")
      return { changes: [Put({ id, type: JOURNEY, props: { name: p.name }, edges: [] })], message: `created ${id}` }
    }),
})

export const editJourney = tool({
  name: "edit-journey",
  description: "Rename a journey.",
  params: Schema.Struct({ id: Schema.String, name: JourneyName }),
  run: ({ id, name }, snap) => Effect.map(getNode(snap, id, JOURNEY), (n) => ({ changes: [Put({ ...n, props: { ...n.props, name } })], message: `updated ${id}` })),
})

// @card UX-0002
export const addCard = tool({
  name: "add-card",
  description: "Add a card: one arrival Given, up to 3 extra Givens, one When, 1-5 Thens. States by {id} or {text}.",
  params: Schema.Struct({
    title: Schema.NonEmptyString.annotate({ description: "Short: who does what." }),
    when: Schema.NonEmptyString.annotate({ description: "The one user action." }),
    by: Schema.optionalKey(Schema.Array(PersonaRef)).annotate({ description: "Who acts in the When: one or more personas (required)." }),
    arrives: StateRef.annotate({ description: "The state the user is in before the action (the Given)." }),
    given: Schema.optionalKey(Schema.Array(StateRef)).annotate({ description: "Up to 3 extra context states (And)." }),
    then: Schema.Array(StateRef).annotate({ description: "1-5 states the action leads to." }),
  }),
  run: (p, snap) =>
    Effect.gen(function* () {
      if (p.by === undefined || p.by.length === 0) return yield* new ToolError({ message: `a card needs at least one persona in by; known: ${known(snap)}` })
      const by = yield* Effect.forEach(p.by, (ref) => personaOf(snap, ref))
      const r = resolver(snap)
      const arrives = yield* r.resolve(p.arrives)
      const given = yield* Effect.forEach(p.given ?? [], r.resolve)
      const then = yield* Effect.forEach(p.then, r.resolve)
      const id = r.next("UX")
      const card: Node = {
        id,
        type: CARD,
        props: { title: p.title, when: p.when },
        edges: [
          ...by.map((to) => ({ type: BY, to })),
          { type: ARRIVES, to: arrives },
          ...given.map((to) => ({ type: GIVEN, to })),
          ...then.map((to) => ({ type: THEN, to })),
        ],
      }
      return { changes: [...r.created.map(Put), Put(card)], message: `created ${id}${createdNote(r.created)}` }
    }),
})

export const editCard = tool({
  name: "edit-card",
  description: "Change a card's title or When, or mark it planned (true: not built yet; false: clears it).",
  params: Schema.Struct({
    id: Schema.String,
    title: Schema.optionalKey(Schema.NonEmptyString),
    when: Schema.optionalKey(Schema.NonEmptyString),
    planned: Schema.optionalKey(Schema.Boolean),
  }),
  run: ({ id, planned, ...patch }, snap) =>
    Effect.map(getNode(snap, id, CARD), (n) => {
      // planned is stored only while true: false removes it.
      const { planned: was, ...rest } = n.props
      const keep = planned ?? was === true
      return { changes: [Put({ ...n, props: { ...rest, ...patch, ...(keep ? { planned: true } : {}) } })], message: `updated ${id}` }
    }),
})

export const link = tool({
  name: "link",
  description: "Connect a card to a state as arrives (replaces the current one), given or then; to a persona as by; or to a journey as in.",
  params: Schema.Struct({ card: Schema.String, edge: EdgeName, state: Schema.optionalKey(StateRef), persona: Schema.optionalKey(PersonaRef), journey: Schema.optionalKey(JourneyRef) }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const card = yield* getNode(snap, p.card, CARD)
      if (p.edge === "by" && p.persona === undefined) return yield* new ToolError({ message: "by takes a persona: {persona: {id} or {name}}" })
      if (p.edge === "in" && p.journey === undefined) return yield* new ToolError({ message: "in takes a journey: {journey: {id} or {name}}" })
      if (p.edge !== "by" && p.edge !== "in" && p.state === undefined) return yield* new ToolError({ message: `${p.edge} takes a state: {state: {id} or {text}}` })
      const r = resolver(snap)
      const to = p.edge === "by" ? yield* personaOf(snap, p.persona!) : p.edge === "in" ? yield* journeyOf(snap, p.journey!) : yield* r.resolve(p.state!)
      const type = edgeType[p.edge]
      if (card.edges.some((e) => e.type === type && e.to === to)) return yield* new ToolError({ message: `${p.card} already has ${p.edge} ${to}` })
      const kept = p.edge === "arrives" ? card.edges.filter((e) => e.type !== ARRIVES) : card.edges
      const changes: Array<Change> = [...r.created.map(Put), Put({ ...card, edges: [...kept, { type, to }] })]
      return { changes, message: `linked ${p.card} ${p.edge} ${to}${createdNote(r.created)}` }
    }),
})

export const unlink = tool({
  name: "unlink",
  description: "Remove a given or then edge (state id), a by edge (persona id) or an in edge (journey id) from a card.",
  params: Schema.Struct({ card: Schema.String, edge: EdgeName, state: Schema.optionalKey(Schema.String), persona: Schema.optionalKey(Schema.String), journey: Schema.optionalKey(Schema.String) }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const card = yield* getNode(snap, p.card, CARD)
      const target = p.edge === "by" ? p.persona : p.edge === "in" ? p.journey : p.state
      if (target === undefined) return yield* new ToolError({ message: p.edge === "by" ? "by takes a persona id" : p.edge === "in" ? "in takes a journey id" : `${p.edge} takes a state id` })
      const type = edgeType[p.edge]
      const edges = card.edges.filter((e) => !(e.type === type && e.to === target))
      if (edges.length === card.edges.length) return yield* new ToolError({ message: `${p.card} has no ${p.edge} ${target}` })
      if (type === BY && !edges.some((e) => e.type === BY)) return yield* new ToolError({ message: `${target} is its last persona on ${p.card}; link another first` })
      return { changes: [Put({ ...card, edges })], message: `unlinked ${p.card} ${p.edge} ${target}` }
    }),
})

export const remove = tool({
  name: "remove",
  description: "Remove a card, or a state, persona or journey that no card uses.",
  params: Schema.Struct({ id: Schema.String }),
  run: ({ id }, snap) =>
    Effect.gen(function* () {
      const n = snap.nodes.get(id)
      if (n === undefined) return yield* new ToolError({ message: `no node ${id}` })
      const users = Snapshot.inbound(snap, id).map((e) => e.from)
      if (users.length > 0) {
        return yield* new ToolError({ message: `${id} is used by ${[...new Set(users)].join(", ")}; relink or remove them first` })
      }
      return { changes: [Remove(id)], message: `removed ${id}` }
    }),
})

export const tools = [addState, editState, addPersona, editPersona, addJourney, editJourney, addCard, editCard, link, unlink, remove]
