import { Deferred, Effect } from "effect"
import { Conversation, type AgentQuestion, PluginFailure, type RawPowers } from "./services"

type Answer = { readonly choice?: string; readonly other?: string }
interface Talk {
  messages: Array<{ readonly id: string; readonly role: "user" | "agent"; readonly text: string }>
  question?: { readonly id: string; readonly question: string; readonly options: AgentQuestion["options"]; readonly allowOther: boolean }
  waiting?: Deferred.Deferred<Answer>
}

/** Conversations of one plugin's agents: kept here, pushed to each agent's `talk` section, answered by the developer. */
export const conversations = (raw: RawPowers) => {
  const talks = new Map<string, Talk>()
  let n = 0
  const talkOf = (agent: string) => {
    let t = talks.get(agent)
    if (t === undefined) talks.set(agent, (t = { messages: [] }))
    return t
  }
  const push = (agent: string) =>
    Effect.tryPromise({
      try: () => {
        const t = talkOf(agent)
        const data = { messages: t.messages, ...(t.question !== undefined ? { question: t.question } : {}), status: t.question !== undefined ? "waiting" : "idle" }
        return raw.call("agents.event", { event: "set", id: agent, section: "talk", data })
      },
      catch: (e) => new PluginFailure({ tag: String((e as { tag?: string }).tag ?? "PluginError"), message: String((e as Error).message ?? e) }),
    })
  const service = Conversation.of({
    say: (agent, text) =>
      Effect.suspend(() => {
        talkOf(agent).messages.push({ id: `m${++n}`, role: "agent", text })
        return Effect.asVoid(push(agent))
      }),
    ask: (agent, q) =>
      Effect.gen(function* () {
        const t = talkOf(agent)
        const waiting = yield* Deferred.make<Answer>()
        t.question = { id: `q${++n}`, question: q.question, options: q.options, allowOther: q.allowOther ?? false }
        t.waiting = waiting
        yield* push(agent)
        // The host stops this call's deadline while the developer thinks.
        const asking = (open: boolean) => Effect.ignore(Effect.tryPromise(() => raw.call("conversation.asking", { open })))
        yield* asking(true)
        return yield* Deferred.await(waiting).pipe(Effect.ensuring(asking(false)))
      }),
  })
  return {
    service,
    /** The developer answered a question in an agent's conversation. */
    answer: async (p: { agent: string; question: string; answer: Answer }) => {
      const t = talks.get(p.agent)
      const waiting = t?.question?.id === p.question ? t.waiting : undefined
      // A question from before a restart has no one waiting: the core withdraws it from the view (this process never knew it).
      if (t === undefined || waiting === undefined) return { notice: "that question is no longer open", withdrawn: true }
      delete t.question
      delete t.waiting
      await Effect.runPromise(Effect.ignore(push(p.agent)))
      await Effect.runPromise(Deferred.succeed(waiting, p.answer))
      return { notice: "answered" }
    },
    /** The developer said something to an agent: it joins the conversation. */
    message: async (p: { agent: string; text: string }) => {
      talkOf(p.agent).messages.push({ id: `m${++n}`, role: "user", text: p.text })
      await Effect.runPromise(Effect.ignore(push(p.agent)))
    },
  }
}
