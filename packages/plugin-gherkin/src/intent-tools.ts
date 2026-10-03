import { Effect, Schema } from "effect"
import { type Node, Put, Snapshot } from "@zarg/graph/pure"
import { tool, ToolError } from "./kit"
import { CONSTRAINT, HAS, INTENT, OUTCOME, QUESTION } from "./model"

const Title = Schema.NonEmptyString.annotate({ description: "What it is for, at most 10 words." })
const Text = Schema.NonEmptyString.annotate({ description: 'One sentence, at most 20 words, no "if", one idea.' })
const Status = Schema.Literals(["draft", "accepted"])

const nodeOf = (snap: Snapshot.Snapshot, id: string, type: string) => {
  const n = snap.nodes.get(id)
  return n?.type === type ? Effect.succeed(n) : Effect.fail(new ToolError({ message: `${id} is not a ${type}` }))
}

export const addIntent = tool({
  name: "add-intent",
  description: "Add an intent: what one product (or one area of it) is for. Its outcomes, constraints and questions come after.",
  params: Schema.Struct({ title: Title, problem: Schema.optionalKey(Schema.String), status: Schema.optionalKey(Status) }),
  run: (p, snap) =>
    Effect.sync(() => {
      const id = Snapshot.nextId(snap, "I")
      return { changes: [Put({ id, type: INTENT, props: { title: p.title, ...(p.problem !== undefined ? { problem: p.problem } : {}), status: p.status ?? "draft" }, edges: [] })], message: `created ${id}` }
    }),
})

export const editIntent = tool({
  name: "edit-intent",
  description: "Change an intent's title, problem or status (draft, accepted).",
  params: Schema.Struct({ id: Schema.String, title: Schema.optionalKey(Title), problem: Schema.optionalKey(Schema.String), status: Schema.optionalKey(Status) }),
  run: ({ id, ...patch }, snap) => Effect.map(nodeOf(snap, id, INTENT), (n) => ({ changes: [Put({ ...n, props: { ...n.props, ...patch } })], message: `updated ${id}` })),
})

/** A new statement in an intent: the node, and the intent with its has edge. */
const addTo = (snap: Snapshot.Snapshot, intent: string, type: string, prefix: string, props: Node["props"]) =>
  Effect.map(nodeOf(snap, intent, INTENT), (i) => {
    const id = Snapshot.nextId(snap, prefix)
    const node: Node = { id, type, props, edges: [] }
    return { id, changes: [Put(node), Put({ ...i, edges: [...i.edges, { type: HAS, to: id }] })] }
  })

const statement = (name: string, type: string, prefix: string, what: string) => ({
  add: tool({
    name: name === "question" ? "ask-question" : `add-${name}`,
    description: `Add ${what} to an intent.`,
    params: Schema.Struct({ intent: Schema.String, text: Text }),
    run: (p, snap) => Effect.map(addTo(snap, p.intent, type, prefix, { text: p.text }), (r) => ({ changes: r.changes, message: `created ${r.id} in ${p.intent}` })),
  }),
  edit: tool({
    name: `edit-${name}`,
    description: `Reword ${what}.`,
    params: Schema.Struct({ id: Schema.String, text: Text }),
    run: ({ id, text }, snap) => Effect.map(nodeOf(snap, id, type), (n) => ({ changes: [Put({ ...n, props: { ...n.props, text } })], message: `updated ${id}` })),
  }),
})

const outcome = statement("outcome", OUTCOME, "O", "an outcome (one result the intent wants for its users)")
const constraint = statement("constraint", CONSTRAINT, "K", "a constraint (one rule that must hold where it bounds)")
const question = statement("question", QUESTION, "Q", "an open question (one thing not decided yet)")

export const answerQuestion = tool({
  name: "answer-question",
  description: "Answer an open question; with as, the answer also becomes an outcome or a constraint of the same intent.",
  params: Schema.Struct({ id: Schema.String, answer: Text, as: Schema.optionalKey(Schema.Literals(["outcome", "constraint"])) }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const q = yield* nodeOf(snap, p.id, QUESTION)
      const answered = Put({ ...q, props: { ...q.props, answer: p.answer } })
      if (p.as === undefined) return { changes: [answered], message: `answered ${p.id}` }
      const intent = Snapshot.inbound(snap, p.id, HAS)[0]?.from
      if (intent === undefined) return yield* new ToolError({ message: `${p.id} is in no intent` })
      const r = yield* addTo(snap, intent, p.as === "outcome" ? OUTCOME : CONSTRAINT, p.as === "outcome" ? "O" : "K", { text: p.answer })
      return { changes: [answered, ...r.changes], message: `answered ${p.id}; created ${r.id} in ${intent}` }
    }),
})

export const intentTools = [addIntent, editIntent, outcome.add, outcome.edit, constraint.add, constraint.edit, question.add, question.edit, answerQuestion]
