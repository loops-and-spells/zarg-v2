import { Effect } from "effect"
import type { Answer, Question } from "@zarg/rlm"
import type { InboxService, Topic } from "./inbox"

/** A grant question as a blocking topic in the operator's inbox (the popover shows it); its answer is the grant's choice. */
export const grantAsk = (inbox: InboxService) => (from: Topic["from"], q: Question) =>
  Effect.map(
    inbox.ask(from, { kind: "grant", title: q.question, why: "grant", answers: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.recommended === true ? { recommended: true } : {}), ...(o.why !== undefined ? { why: o.why } : {}) })) }),
    (r): Answer => (r.answer !== undefined ? { choice: r.answer } : { other: r.text ?? "" }),
  )
