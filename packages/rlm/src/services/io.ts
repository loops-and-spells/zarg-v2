import { Effect, Schema } from "effect"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"

const Raised = Schema.Struct({ title: Schema.String, detail: Schema.String, about: Schema.Array(Schema.String) })
export type Raised = typeof Raised.Type

export const AgendaDef = defineService("Agenda", "Raise items for a driver thread to take up.", {
  raise: { doc: "Raise an item (for example a card that cannot be implemented as written).", params: Raised, success: Schema.Struct({ id: Schema.String }) },
})

/** Where raised items go; 2b replaces this with the project's agenda. */
export interface AgendaInbox {
  readonly raise: (item: Raised) => Effect.Effect<string, ServiceFailure>
}

export const agenda = (inbox: AgendaInbox): Bound => bind(AgendaDef, { raise: (item) => Effect.map(inbox.raise(item), (id) => ({ id })) })

const Option = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  recommended: Schema.optionalKey(Schema.Boolean),
  why: Schema.optionalKey(Schema.String),
})
const Question = Schema.Struct({
  question: Schema.String,
  options: Schema.Array(Option),
  allowOther: Schema.optionalKey(Schema.Boolean),
  about: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Question = typeof Question.Type
/** An option id, or free text; `interjected` when the developer wrote a message instead of answering. */
const Answer = Schema.Struct({ choice: Schema.optionalKey(Schema.String), other: Schema.optionalKey(Schema.String), interjected: Schema.optionalKey(Schema.Boolean) })
export type Answer = typeof Answer.Type

export const InquireDef = defineService("Inquire", "Ask the developer a question. The cell waits (yielded) until they answer.", {
  ask: { doc: "Ask with 2-4 options; mark one recommended with why. The answer is an option id or free text.", params: Question, success: Answer },
})

/** How questions reach the developer; 2b implements it with AG-UI interrupts. */
export interface Asker {
  readonly ask: (q: Question) => Effect.Effect<Answer, ServiceFailure>
}

export const inquire = (asker: Asker): Bound =>
  bind(InquireDef, {
    ask: (q) =>
      q.options.length < 2 || q.options.length > 4
        ? Effect.fail({ _tag: "InvalidQuestion", message: `ask with 2 to 4 options, got ${q.options.length}` })
        : asker.ask(q),
  })

const DQuestion = Schema.Union([
  Schema.Struct({ type: Schema.Literal("choice"), instructions: Schema.String, criteria: Schema.Record(Schema.String, Schema.String) }),
  Schema.Struct({ type: Schema.Literal("noul"), instructions: Schema.String }),
  Schema.Struct({ type: Schema.Literal("score"), instructions: Schema.String, levels: Schema.Array(Schema.String) }),
])
const DAnswer = Schema.Struct({
  type: Schema.String,
  choice: Schema.optionalKey(Schema.String),
  answer: Schema.optionalKey(Schema.Boolean),
  level: Schema.optionalKey(Schema.String),
  score: Schema.optionalKey(Schema.Number),
  probability: Schema.optionalKey(Schema.Number),
  confidence: Schema.Number,
})

export const DecisionsDef = defineService("Decisions", "Fast judgments by a small decision model: choice, yes/no (noul), or score, each with a confidence.", {
  decide: {
    doc: "Answer 1-8 questions about a state. Use it to classify work or check a result before acting on it.",
    params: Schema.Struct({ state: Schema.String, questions: Schema.Record(Schema.String, DQuestion) }),
    success: Schema.Record(Schema.String, DAnswer),
  },
})

/** The Decisions service (from @zarg/decisions) as a kernel service. */
export const decisionsService = (decisions: {
  readonly decide: (req: { state: string; questions: Record<string, unknown> }) => Effect.Effect<Readonly<Record<string, unknown>>, { readonly message: string; readonly kind?: string }>
}): Bound =>
  bind(DecisionsDef, {
    decide: (req) =>
      decisions.decide(req as never).pipe(
        Effect.map((answers) => answers as never),
        Effect.mapError((e): ServiceFailure => ({ _tag: "DecisionError", message: e.message })),
      ),
  })
