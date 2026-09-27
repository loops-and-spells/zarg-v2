import { Effect, Schema } from "effect"
import { type Change, type Node, Put, Remove, Snapshot } from "@zarg/graph/pure"
import { tool, ToolError } from "./kit"
import { ARRIVES, CARD, findStateByText, GIVEN, STATE, THEN } from "./model"

/** Point at an existing state by id, or describe one by text (reused if the text already exists). */
const StateRef = Schema.Union([Schema.Struct({ id: Schema.String }), Schema.Struct({ text: Schema.NonEmptyString })]).annotate({
  description: "An existing state by {id}, or a sentence by {text} (existing text is reused).",
})
type StateRef = typeof StateRef.Type

const EdgeName = Schema.Literals(["arrives", "given", "then"])
const edgeType = { arrives: ARRIVES, given: GIVEN, then: THEN } as const

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

// @card UX-0002
export const addCard = tool({
  name: "add-card",
  description: "Add a card: one arrival Given, up to 3 extra Givens, one When, 1-5 Thens. States by {id} or {text}.",
  params: Schema.Struct({
    title: Schema.NonEmptyString.annotate({ description: "Short: who does what." }),
    when: Schema.NonEmptyString.annotate({ description: "The one user action." }),
    arrives: StateRef.annotate({ description: "The state the user is in before the action (the Given)." }),
    given: Schema.optionalKey(Schema.Array(StateRef)).annotate({ description: "Up to 3 extra context states (And)." }),
    then: Schema.Array(StateRef).annotate({ description: "1-5 states the action leads to." }),
  }),
  run: (p, snap) =>
    Effect.gen(function* () {
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
  description: "Change a card's title or When.",
  params: Schema.Struct({
    id: Schema.String,
    title: Schema.optionalKey(Schema.NonEmptyString),
    when: Schema.optionalKey(Schema.NonEmptyString),
  }),
  run: ({ id, ...patch }, snap) =>
    Effect.map(getNode(snap, id, CARD), (n) => ({
      changes: [Put({ ...n, props: { ...n.props, ...patch } })],
      message: `updated ${id}`,
    })),
})

export const link = tool({
  name: "link",
  description: "Connect a card to a state as arrives (replaces the current one), given, or then.",
  params: Schema.Struct({ card: Schema.String, edge: EdgeName, state: StateRef }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const card = yield* getNode(snap, p.card, CARD)
      const r = resolver(snap)
      const to = yield* r.resolve(p.state)
      const type = edgeType[p.edge]
      if (card.edges.some((e) => e.type === type && e.to === to)) {
        return yield* new ToolError({ message: `${p.card} already has ${p.edge} ${to}` })
      }
      const kept = p.edge === "arrives" ? card.edges.filter((e) => e.type !== ARRIVES) : card.edges
      const changes: Array<Change> = [...r.created.map(Put), Put({ ...card, edges: [...kept, { type, to }] })]
      return { changes, message: `linked ${p.card} ${p.edge} ${to}${createdNote(r.created)}` }
    }),
})

export const unlink = tool({
  name: "unlink",
  description: "Remove a given or then edge from a card.",
  params: Schema.Struct({ card: Schema.String, edge: EdgeName, state: Schema.String }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const card = yield* getNode(snap, p.card, CARD)
      const type = edgeType[p.edge]
      const edges = card.edges.filter((e) => !(e.type === type && e.to === p.state))
      if (edges.length === card.edges.length) {
        return yield* new ToolError({ message: `${p.card} has no ${p.edge} ${p.state}` })
      }
      return { changes: [Put({ ...card, edges })], message: `unlinked ${p.card} ${p.edge} ${p.state}` }
    }),
})

export const remove = tool({
  name: "remove",
  description: "Remove a card, or a state that no card uses.",
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

export const tools = [addState, editState, addCard, editCard, link, unlink, remove]
