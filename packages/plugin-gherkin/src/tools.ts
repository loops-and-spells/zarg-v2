import { Effect, Schema } from "effect"
import { type Change, type Node, Put, Remove, Snapshot } from "@zarg/graph/pure"
import { tool, ToolError } from "./kit"
import { intentTools } from "./intent-tools"
import { ARRIVES, BOUNDS, BY, CONSTRAINT, findJourney, findPersona, findStateByText, FOR, GIVEN, HAS, IN, INTENT, isStatement, JOURNEY, journeyName, journeys, OUTCOME, PERSONA, personaName, personas, SCENARIO, SERVES, STATE, THEN } from "./model"

/** Point at an existing state by id, or describe one by text (reused if the text already exists). */
const StateRef = Schema.Union([Schema.Struct({ id: Schema.String }), Schema.Struct({ text: Schema.NonEmptyString })]).annotate({
  description: "An existing state by {id}, or a sentence by {text} (existing text is reused).",
})
type StateRef = typeof StateRef.Type

const EdgeName = Schema.Literals(["arrives", "given", "then", "by", "in", "serves", "bounds", "for"])
const edgeType = { arrives: ARRIVES, given: GIVEN, then: THEN, by: BY, in: IN, serves: SERVES, bounds: BOUNDS, for: FOR } as const

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
  name: Schema.NonEmptyString.annotate({ description: "Short and unique, at most 4 words; its scenarios' titles start with it." }),
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
    const node: Node = { id: Snapshot.nextId(working, "ST"), type: STATE, props: { text: ref.text }, edges: [] }
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
      const id = Snapshot.nextId(snap, "ST")
      return { changes: [Put({ id, type: STATE, props: { ...p }, edges: [] })], message: `created ${id}` }
    }),
})

// @scenario S-0004
export const editState = tool({
  name: "edit-state",
  description: "Reword a state or change its entry/terminal flags. Every scenario using it updates.",
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
  description: "Add a persona: someone who acts in scenarios (the operator, a CLI actor, an agent).",
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
  description: "Add a journey: a name scenarios can be tagged with (link {edge: \"in\"}); a scenario can be in several.",
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

// @scenario S-0002
export const addScenario = tool({
  name: "add-scenario",
  description: "Add a scenario: one arrival Given, up to 3 extra Givens, one When, 1-5 Thens. States by {id} or {text}.",
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
      if (p.by === undefined || p.by.length === 0) return yield* new ToolError({ message: `a scenario needs at least one persona in by; known: ${known(snap)}` })
      const by = yield* Effect.forEach(p.by, (ref) => personaOf(snap, ref))
      const r = resolver(snap)
      const arrives = yield* r.resolve(p.arrives)
      const given = yield* Effect.forEach(p.given ?? [], r.resolve)
      const then = yield* Effect.forEach(p.then, r.resolve)
      const id = r.next("S")
      const scenario: Node = {
        id,
        type: SCENARIO,
        props: { title: p.title, when: p.when },
        edges: [
          ...by.map((to) => ({ type: BY, to })),
          { type: ARRIVES, to: arrives },
          ...given.map((to) => ({ type: GIVEN, to })),
          ...then.map((to) => ({ type: THEN, to })),
        ],
      }
      return { changes: [...r.created.map(Put), Put(scenario)], message: `created ${id}${createdNote(r.created)}` }
    }),
})

export const editScenario = tool({
  name: "edit-scenario",
  description: "Change a scenario's title or When, or mark it planned (true: not built yet; false: clears it).",
  params: Schema.Struct({
    id: Schema.String,
    title: Schema.optionalKey(Schema.NonEmptyString),
    when: Schema.optionalKey(Schema.NonEmptyString),
    planned: Schema.optionalKey(Schema.Boolean),
  }),
  run: ({ id, planned, ...patch }, snap) =>
    Effect.map(getNode(snap, id, SCENARIO), (n) => {
      // planned is stored only while true: false removes it.
      const { planned: was, ...rest } = n.props
      const keep = planned ?? was === true
      return { changes: [Put({ ...n, props: { ...rest, ...patch, ...(keep ? { planned: true } : {}) } })], message: `updated ${id}` }
    }),
})

export const link = tool({
  name: "link",
  description:
    'Connect a scenario to a state as arrives (replaces the current one), given or then; to a persona as by; or to a journey as in. Also: a journey serves an outcome {edge: "serves", journey, outcome}; a constraint bounds a journey or a scenario {edge: "bounds", constraint, journey or scenario}; an intent is for a persona {edge: "for", intent, persona}.',
  params: Schema.Struct({
    scenario: Schema.optionalKey(Schema.String),
    edge: EdgeName,
    state: Schema.optionalKey(StateRef),
    persona: Schema.optionalKey(PersonaRef),
    journey: Schema.optionalKey(JourneyRef),
    outcome: Schema.optionalKey(Schema.String),
    constraint: Schema.optionalKey(Schema.String),
    intent: Schema.optionalKey(Schema.String),
  }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const type = edgeType[p.edge]
      // The source owns the edge: the journey (serves), the constraint (bounds), the intent (for), else the scenario.
      const linkFrom = (source: Node, to: string, created: ReadonlyArray<Node> = []) =>
        source.edges.some((e) => e.type === type && e.to === to)
          ? Effect.fail(new ToolError({ message: `${source.id} already has ${p.edge} ${to}` }))
          : Effect.succeed({
              changes: [...created.map(Put), Put({ ...source, edges: [...(p.edge === "arrives" ? source.edges.filter((e) => e.type !== ARRIVES) : source.edges), { type, to }] })] as Array<Change>,
              message: `linked ${source.id} ${p.edge} ${to}${createdNote(created)}`,
            })
      if (p.edge === "serves") {
        if (p.journey === undefined || p.outcome === undefined) return yield* new ToolError({ message: "serves takes {journey: {id} or {name}, outcome: id}" })
        const journey = yield* getNode(snap, yield* journeyOf(snap, p.journey), JOURNEY)
        yield* getNode(snap, p.outcome, OUTCOME)
        return yield* linkFrom(journey, p.outcome)
      }
      if (p.edge === "bounds") {
        if (p.constraint === undefined || (p.journey === undefined) === (p.scenario === undefined)) return yield* new ToolError({ message: "bounds takes {constraint: id} and one of {journey: {id} or {name}} or {scenario: id}" })
        const constraint = yield* getNode(snap, p.constraint, CONSTRAINT)
        const to = p.journey !== undefined ? yield* journeyOf(snap, p.journey) : (yield* getNode(snap, p.scenario!, SCENARIO)).id
        return yield* linkFrom(constraint, to)
      }
      if (p.edge === "for") {
        if (p.intent === undefined || p.persona === undefined) return yield* new ToolError({ message: "for takes {intent: id, persona: {id} or {name}}" })
        return yield* linkFrom(yield* getNode(snap, p.intent, INTENT), yield* personaOf(snap, p.persona))
      }
      if (p.scenario === undefined) return yield* new ToolError({ message: `${p.edge} takes {scenario: id}` })
      const scenario = yield* getNode(snap, p.scenario, SCENARIO)
      if (p.edge === "by" && p.persona === undefined) return yield* new ToolError({ message: "by takes a persona: {persona: {id} or {name}}" })
      if (p.edge === "in" && p.journey === undefined) return yield* new ToolError({ message: "in takes a journey: {journey: {id} or {name}}" })
      if (p.edge !== "by" && p.edge !== "in" && p.state === undefined) return yield* new ToolError({ message: `${p.edge} takes a state: {state: {id} or {text}}` })
      const r = resolver(snap)
      const to = p.edge === "by" ? yield* personaOf(snap, p.persona!) : p.edge === "in" ? yield* journeyOf(snap, p.journey!) : yield* r.resolve(p.state!)
      return yield* linkFrom(scenario, to, r.created)
    }),
})

export const unlink = tool({
  name: "unlink",
  description:
    "Remove a given or then edge (state id), a by edge (persona id) or an in edge (journey id) from a scenario; or serves {journey: id, outcome}, bounds {constraint, journey or scenario: id}, for {intent, persona: id}.",
  params: Schema.Struct({
    scenario: Schema.optionalKey(Schema.String),
    edge: EdgeName,
    state: Schema.optionalKey(Schema.String),
    persona: Schema.optionalKey(Schema.String),
    journey: Schema.optionalKey(Schema.String),
    outcome: Schema.optionalKey(Schema.String),
    constraint: Schema.optionalKey(Schema.String),
    intent: Schema.optionalKey(Schema.String),
  }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const type = edgeType[p.edge]
      const [sourceId, target, sourceType] =
        p.edge === "serves" ? [p.journey, p.outcome, JOURNEY]
        : p.edge === "bounds" ? [p.constraint, p.journey ?? p.scenario, CONSTRAINT]
        : p.edge === "for" ? [p.intent, p.persona, INTENT]
        : [p.scenario, p.edge === "by" ? p.persona : p.edge === "in" ? p.journey : p.state, SCENARIO]
      if (sourceId === undefined || target === undefined)
        return yield* new ToolError({ message: p.edge === "by" ? "by takes a persona id" : p.edge === "in" ? "in takes a journey id" : `${p.edge} takes its source and target ids` })
      const source = yield* getNode(snap, sourceId, sourceType)
      const edges = source.edges.filter((e) => !(e.type === type && e.to === target))
      if (edges.length === source.edges.length) return yield* new ToolError({ message: `${sourceId} has no ${p.edge} ${target}` })
      if (type === BY && !edges.some((e) => e.type === BY)) return yield* new ToolError({ message: `${target} is its last persona on ${sourceId}; link another first` })
      return { changes: [Put({ ...source, edges })], message: `unlinked ${sourceId} ${p.edge} ${target}` }
    }),
})

export const remove = tool({
  name: "remove",
  description: "Remove a scenario (and the constraints' bounds edges to it); a state, persona or journey that nothing else uses; an outcome, constraint or question (with the edges to it); or an intent without statements.",
  params: Schema.Struct({ id: Schema.String }),
  run: ({ id }, snap) =>
    Effect.gen(function* () {
      const n = snap.nodes.get(id)
      if (n === undefined) return yield* new ToolError({ message: `no node ${id}` })
      // A statement goes with the edges that point at it (its intent's has, the journeys' serves).
      if (isStatement(n)) {
        const sources = [...new Set(Snapshot.inbound(snap, id).map((e) => e.from))].flatMap((s) => {
          const src = snap.nodes.get(s)
          return src === undefined ? [] : [src]
        })
        return { changes: [...sources.map((s) => Put({ ...s, edges: s.edges.filter((e) => e.to !== id) })), Remove(id)], message: `removed ${id}` }
      }
      if (n.type === INTENT) {
        const own = n.edges.filter((e) => e.type === HAS).map((e) => e.to)
        if (own.length > 0) return yield* new ToolError({ message: `${id} has statements ${own.join(", ")}; remove them first` })
      }
      // A constraint's bounds edge goes with what it bounds (a scenario, a journey): the rule simply applies to less.
      const bounding = [...new Set(Snapshot.inbound(snap, id, BOUNDS).map((e) => e.from))].flatMap((c) => {
        const src = snap.nodes.get(c)
        return src === undefined ? [] : [Put({ ...src, edges: src.edges.filter((e) => !(e.type === BOUNDS && e.to === id)) })]
      })
      const users = Snapshot.inbound(snap, id).filter((e) => e.edge.type !== BOUNDS).map((e) => e.from)
      if (users.length > 0) {
        return yield* new ToolError({ message: `${id} is used by ${[...new Set(users)].join(", ")}; relink or remove them first` })
      }
      return { changes: [...bounding, Remove(id)], message: `removed ${id}` }
    }),
})

export const tools = [addState, editState, addPersona, editPersona, addJourney, editJourney, addScenario, editScenario, link, unlink, remove, ...intentTools]
