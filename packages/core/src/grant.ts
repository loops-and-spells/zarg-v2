import { Effect } from "effect"
import type { Answer, Question } from "@zarg/rlm"
import type { InboxService } from "./inbox"

/**
 * A grant question as a blocking topic in the operator's inbox (the popover shows it); its answer is the grant's
 * choice. Raised as zarg's (the words are the core's: the plugin cannot rewrite them), naming the plugin that asks.
 */
export const grantAsk = (inbox: InboxService) => (asker: string, q: Question) =>
  Effect.map(
    inbox.ask({ plugin: "zarg", agent: asker }, { kind: "grant", title: q.question, why: "grant", answers: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.recommended === true ? { recommended: true } : {}), ...(o.why !== undefined ? { why: o.why } : {}) })) }),
    (r): Answer => (r.answer !== undefined ? { choice: r.answer } : { other: r.text ?? "" }),
  )

/** The thread one of zarg's question topics belongs to: its key is `<thread>|<interrupt>` (older keys: main). */
export const threadOfTopic = (key: string | undefined) => (key !== undefined && key.includes("|") ? key.slice(0, key.indexOf("|")) : "main")
