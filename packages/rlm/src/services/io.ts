import { Effect, Schema } from "effect"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"

const Raised = Schema.Struct({
  title: Schema.String,
  detail: Schema.String,
  about: Schema.Array(Schema.String).annotate({ description: "Scenario or state ids the item is about." }),
})
export type Raised = typeof Raised.Type

export const AgendaDef = defineService("Agenda", "Raise items for a driver thread to take up.", {
  raise: { doc: "Raise an item (for example a scenario that cannot be implemented as written).", params: Raised, success: Schema.Struct({ id: Schema.String }) },
})

/** Where raised items go; 2b replaces this with the project's agenda. */
export interface AgendaInbox {
  readonly raise: (item: Raised) => Effect.Effect<string, ServiceFailure>
}

export const agenda = (inbox: AgendaInbox): Bound => bind(AgendaDef, { raise: (item) => Effect.map(inbox.raise(item), (id) => ({ id })) })

const Option = Schema.Struct({
  id: Schema.String.annotate({ description: "Returned as the answer's `choice` when the developer picks this option." }),
  label: Schema.String.annotate({ description: "What the developer reads: a few words." }),
  recommended: Schema.optionalKey(Schema.Boolean).annotate({ description: "Mark exactly one option as your recommendation." }),
  why: Schema.optionalKey(Schema.String).annotate({ description: "One short reason, shown next to the option." }),
  change: Schema.optionalKey(Schema.String).annotate({
    description: "When picking this option is itself a requirements change: the exact change, as Inquire.confirm would show it. The developer sees it with the question; picking it adds it (write it, no confirm after).",
  }),
})
const Question = Schema.Struct({
  question: Schema.String.annotate({ description: "One question, in a sentence or two." }),
  options: Schema.Array(Option).annotate({ description: "2 to 4 options." }),
  allowOther: Schema.optionalKey(Schema.Boolean).annotate({ description: "Offer \"Something else…\" for a free-text answer (the answer's `other`)." }),
  otherLabel: Schema.optionalKey(Schema.String).annotate({ description: "The free-text row's label, when not \"Something else\"." }),
  about: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Scenario or state ids the whole question is about (not per option)." }),
})
/** `kind: "grant"`: a permission question zarg itself asks (never a cell: the schema has no such field); only its options are offered. */
export type Question = typeof Question.Type & { readonly kind?: "grant" }
/** An option id, or free text; `interjected` when the operator wrote a message instead of answering. */
// @scenario S-0102
const Answer = Schema.Struct({
  choice: Schema.optionalKey(Schema.String).annotate({ description: "The option the developer picked." }),
  other: Schema.optionalKey(Schema.String).annotate({ description: "What the developer wrote instead (Something else…, or a message about the question)." }),
  interjected: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "True when the developer is discussing the question, not answering it: reply to what they wrote, then either Inquire.choose an option they settled on or Inquire.ask again. When what they wrote says what the product is for, propose keeping it in the intent first (add-outcome, add-constraint) with Inquire.confirm. Never change the graph without their say.",
  }),
  question: Schema.optionalKey(Schema.String).annotate({ description: "With interjected: the id of the question still open for Inquire.choose." }),
  hint: Schema.optionalKey(Schema.String).annotate({ description: "With interjected: what to do with what they wrote." }),
  goal: Schema.optionalKey(Schema.Boolean).annotate({ description: "With interjected: zarg judged that what they wrote states a goal or a rule for the product." }),
})
export type Answer = typeof Answer.Type
/** Said when zarg judged the interjection to state a goal for the product: the next call, not a condition to weigh. */
export const GOAL_HINT =
  "They stated a goal or a rule for the product. Your next call: Inquire.confirm a change that keeps it in its intent (add-outcome for a result it should reach, add-constraint for a rule it must keep), in their words; write it once they add it. Then go back to your question."
/** Said with every interjected answer: the model reads it in the result, where a schema's doc is easy to skip. */
export const INTERJECTED_HINT =
  "They wrote this instead of answering. Reply to it first. When it says what the product is for (an outcome to reach, a rule to keep), propose keeping it in the intent now: Inquire.confirm the change, then add-outcome or add-constraint. Then Inquire.choose the open question if it is settled, or ask it again."

const Choice = Schema.Struct({
  question: Schema.String.annotate({ description: "The id of a question under discussion (an interjected answer's `question`)." }),
  choice: Schema.String.annotate({ description: "One of that question's option ids." }),
  why: Schema.String.annotate({ description: "One sentence: what the developer said that settles it; shown to them." }),
})
export type Choice = typeof Choice.Type

const Confirm = Schema.Struct({
  change: Schema.String.annotate({
    description: "The exact change in the operator's words: each scenario as By / Given / When / Then lines (and any state or persona edits), as it will be written.",
  }),
  about: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Scenario or state ids the change touches." }),
})
export type Confirm = typeof Confirm.Type

/** The question Inquire.confirm asks: the change itself, with add, change and skip. */
export const confirmQuestion = (c: Confirm): Question => ({
  question: `Add this to the requirements?\n\n${c.change}`,
  options: [
    { id: "add", label: "Add it", recommended: true, why: "as written" },
    { id: "skip", label: "Skip" },
  ],
  // Changing it is saying what to change.
  allowOther: true,
  otherLabel: "Change it",
  ...(c.about !== undefined ? { about: c.about } : {}),
})

export const InquireDef = defineService("Inquire", "Ask the developer a question. The cell waits (yielded) until they answer.", {
  confirm: {
    doc: "Show the developer the exact change before writing it to the graph. The answer: `add` (write it), `skip`, or `other` = what they want changed: revise the change and confirm it again. Graph writes are refused until they add it, and closed again by your next question.",
    params: Confirm,
    success: Answer,
  },
  ask: { doc: "Ask with 2-4 options; mark one recommended with why. The answer is an option id or free text.", params: Question, success: Answer },
  choose: {
    doc: "Accept an option of a question under discussion for the developer, when the conversation settled it. They see what you chose and why.",
    params: Choice,
    success: Schema.Struct({ choice: Schema.String }),
  },
})

/** How questions reach the operator; 2b implements it with AG-UI interrupts. */
export interface Asker {
  readonly ask: (q: Question) => Effect.Effect<Answer, ServiceFailure>
  /** Close a question under discussion with one of its options, for the operator. */
  readonly choose?: (c: Choice) => Effect.Effect<{ readonly choice: string }, ServiceFailure>
  /** Show a change for the operator to add, change or skip; defaults to `ask` with `confirmQuestion`. */
  readonly confirm?: (c: Confirm) => Effect.Effect<Answer, ServiceFailure>
  /** A change the operator already added (shown before a restart): the item may write it without showing it again. Taken once. */
  readonly approved?: () => string | undefined
}

export const inquire = (asker: Asker): Bound =>
  bind(InquireDef, {
    confirm: (c) => (asker.confirm !== undefined ? asker.confirm(c) : asker.ask(confirmQuestion(c))),
    // @scenario S-0012 S-0102
    ask: (q) =>
      q.options.length < 2 || q.options.length > 4
        ? Effect.fail({ _tag: "InvalidQuestion", message: `ask with 2 to 4 options, got ${q.options.length}` })
        : Effect.map(asker.ask(q), (a) => (a.interjected === true ? { ...a, hint: a.goal === true ? GOAL_HINT : INTERJECTED_HINT } : a)),
    choose: (c) =>
      asker.choose === undefined
        ? Effect.fail({ _tag: "NoOpenQuestion", message: `no question ${c.question} is under discussion; ask with Inquire.ask` })
        : asker.choose(c),
  })

const DQuestion = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: Schema.String.annotate({ description: "What to pick." }),
    criteria: Schema.Record(Schema.String, Schema.String).annotate({ description: "Choice key to what it means; the answer's `choice` is a key." }),
  }),
  Schema.Struct({ type: Schema.Literal("noul"), instructions: Schema.String.annotate({ description: "A yes/no question; the answer is `answer`." }) }),
  Schema.Struct({
    type: Schema.Literal("score"),
    instructions: Schema.String.annotate({ description: "What to score." }),
    levels: Schema.Array(Schema.String).annotate({ description: "Levels from lowest to highest; the answer's `level` is one of them." }),
  }),
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
    doc: "Answer 1-8 questions about a state. Use it to classify work or check a result before acting on it. An answer with confidence below 0.5 is a guess: never act on it or choose for the developer with it; ask them instead.",
    params: Schema.Struct({
      state: Schema.String.annotate({ description: "What the questions are about: the situation in plain text, short." }),
      questions: Schema.Record(Schema.String, DQuestion).annotate({ description: "1-8 questions by name; the result has the same names." }),
    }),
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
