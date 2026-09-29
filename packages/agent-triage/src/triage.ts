import { Effect, Fiber, Semaphore } from "effect"
import { parseRef } from "@zarg/entities"
import type { Working } from "./view"

type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
type Try = { readonly ms: number; readonly tokensIn: number; readonly tokensOut: number; readonly reasoning: number; readonly finish?: string; readonly problems: ReadonlyArray<string> }
type Proposal = { readonly card: string; readonly title?: string; readonly tries?: ReadonlyArray<Try>; readonly changes: Draft; readonly answers: ReadonlyArray<string>; readonly summary: string; readonly status: "waiting" | "proposed" | "accepted" | "skipped"; readonly problems?: ReadonlyArray<string> }
type Fresh = { readonly card: string; readonly kind: string; readonly severity: string; readonly note: string }
export interface StageView {
  readonly journey: string
  readonly stage: "triage" | "refine" | "rehearse" | "plan" | "planned"
  readonly proposals: ReadonlyArray<Proposal>
  readonly draft: Draft
  readonly cards?: ReadonlyArray<string>
  readonly run?: string
  readonly results?: { readonly resolved: ReadonlyArray<string>; readonly fresh: ReadonlyArray<Fresh> }
  readonly plan?: { readonly title: string; readonly steps: ReadonlyArray<string> }
  readonly item?: string
  readonly queued?: number
  readonly worker?: string
  readonly dropRun?: string
  readonly dismissed?: ReadonlyArray<{ readonly card: string; readonly kind: string }>
}
type OnEntry = { readonly id: string; readonly ref: string; readonly kind: string; readonly severity: string; readonly note: string; readonly persona: string; readonly on: boolean; readonly operatorNote?: string }
type Step = { readonly card: string; readonly title: string; readonly given: string; readonly when: string; readonly thens: ReadonlyArray<string>; readonly by?: ReadonlyArray<string> } | null

/** The Triage Agent's powers, as plain functions (the plugin wires them to its contracts; tests stub them). */
export interface TriageDeps {
  readonly stages: () => Effect.Effect<ReadonlyArray<StageView>, unknown>
  readonly feedbackOf: (journey: string) => Effect.Effect<ReadonlyArray<OnEntry>, unknown>
  readonly journeys: () => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string; readonly cards: ReadonlyArray<string> }>, unknown>
  readonly step: (card: string, draft: Draft) => Effect.Effect<Step, unknown>
  readonly dryRun: (draft: Draft) => Effect.Effect<{ readonly ok: boolean; readonly problems: ReadonlyArray<string>; readonly touched: ReadonlyArray<string>; readonly cards: ReadonlyArray<string> }, unknown>
  readonly complete: (req: { readonly messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>; readonly maxTokens?: number; readonly reasoning?: { readonly enabled: boolean } }) => Effect.Effect<{ readonly text: string; readonly promptTokens?: number; readonly completionTokens?: number; readonly reasoningTokens?: number; readonly finishReason?: string }, unknown>
  readonly propose: (p: { readonly journey: string; readonly card: string; readonly title?: string; readonly tries?: ReadonlyArray<Try>; readonly changes: Draft; readonly answers: ReadonlyArray<string>; readonly summary: string; readonly problems?: ReadonlyArray<string> }) => Effect.Effect<void, unknown>
  readonly rehearsing: (p: { readonly journey: string; readonly run?: string; readonly cards?: ReadonlyArray<string>; readonly note?: string; readonly clear?: boolean; readonly dropped?: boolean }) => Effect.Effect<void, unknown>
  /** The accepted draft fails as a whole: back to Refine with the problems. */
  readonly redraft: (p: { readonly journey: string; readonly problems: ReadonlyArray<string> }) => Effect.Effect<void, unknown>
  readonly rehearsed: (p: { readonly journey: string; readonly resolved: ReadonlyArray<string>; readonly fresh: ReadonlyArray<Fresh>; readonly next: "plan" | "refine"; readonly cards?: ReadonlyArray<string> }) => Effect.Effect<void, unknown>
  readonly drafted: (p: { readonly journey: string; readonly title: string; readonly steps: ReadonlyArray<string> }) => Effect.Effect<void, unknown>
  readonly run: (p: { readonly strategy: "journey"; readonly focus: ReadonlyArray<string>; readonly draft: Draft; readonly file: false }) => Effect.Effect<{ readonly run?: string; readonly refused?: string }, unknown>
  readonly result: (run: string) => Effect.Effect<{ readonly status: string; readonly findings: ReadonlyArray<Fresh & { readonly on: boolean }> }, unknown>
  /** Stop that rehearse run, when it is the one going. */
  readonly stop: (run: string) => Effect.Effect<void, unknown>
  /** The agent's row: what it does now. */
  readonly status: (agent: string, text: string) => Effect.Effect<void, unknown>
  /** A line in the agent's history: what it did, and why when it failed. */
  readonly log: (agent: string, text: string) => Effect.Effect<void, unknown>
  /** Tell the backlog which worker took a journey (none: it let it go). */
  readonly assign: (journey: string, worker?: string) => Effect.Effect<void, unknown>
  /** A worker took a journey (its agent starts) or let it go (undefined: its agent ends). */
  readonly worker: (id: string, journey: string | undefined) => Effect.Effect<void, unknown>
  /** The time now (ms): how long each try takes. */
  readonly now: Effect.Effect<number, unknown>
  /** Draw the agent's view again (a card started or ended, a run started). */
  readonly render: Effect.Effect<void, unknown>
}

/** The first JSON object in a model's answer (in a fence, or with words around it); undefined when there is none. */
export const jsonIn = (text: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  for (const candidate of [fenced, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (candidate === undefined || candidate.trim().length === 0) continue
    try {
      return JSON.parse(candidate)
    } catch {}
  }
  return undefined
}

const TOOLS = [
  'edit-state {"id":"S-0002","text":"…"}: reword a Given/Then sentence (every card using it changes)',
  'edit-card {"id":"UX-0001","title":"…","when":"…"}: change a card\'s title or When',
  'add-card {"title":"Who does what","when":"the one action","by":[{"name":"Operator"}],"arrives":{"id":"S-0001"},"then":[{"text":"…"}]}: a new card (1-5 thens)',
  'link {"card":"UX-0001","edge":"then","state":{"text":"…"}}: add a then (or given; arrives replaces the Given)',
  'unlink {"card":"UX-0001","edge":"then","state":"S-0002"}: remove one (a card keeps at least one then)',
].join("\n")
export const SYSTEM = [
  "You refine a product's requirements: Gherkin cards (Given, When, Then) that testers found problems with.",
  "Propose the smallest change to the graph that answers the feedback, as gherkin tool calls in order. Clauses at most 15 words; never 'if' (one card per case).",
  "The operator's notes say how they want the feedback answered: follow them over the tester's words.",
  `Tools:\n${TOOLS}`,
  "Refer to states that exist by id; name every new state by text (its id is made when the plan is applied, so never guess one).",
  'Answer with JSON only: {"changes":[{"tool":"…","params":{…}}],"answers":["F-…"],"summary":"one sentence for the operator"}.',
].join("\n\n")
const stepText = (s: Step) => (s === null ? "(this card is not in the graph)" : [`${s.card} ${s.title}`, ...(s.by !== undefined && s.by.length > 0 ? [`By    ${s.by.join(", ")}`] : []), `Given ${s.given}`, `When  ${s.when}`, ...s.thens.map((t, i) => `${i === 0 ? "Then" : "And "}  ${t}`)].join("\n"))
const cardOf = (ref: string) => parseRef(ref)?.id ?? ref

/** The Triage Agent: the agent's part of each journey's stage, whenever the core wakes it. */
type Slot = { readonly id: string; journey?: string | undefined; at?: Working | undefined; busy: boolean }
export const makeTriage = (d: TriageDeps, workers = 2, reasoning = false) => {
  const quiet = <A>(e: Effect.Effect<A, unknown>) => Effect.ignore(e)
  const clock = d.now.pipe(Effect.orElseSucceed(() => 0))
  // Paused, no worker starts a card; each worker's card (or "" for the run it waits on), and since when.
  let paused = false
  const runsSince = new Map<string, number>()
  const at = (w: Slot, now: Working | undefined) => Effect.andThen(Effect.sync(() => (w.at = now)), quiet(d.render))
  /** The model's answer; undefined when it did not answer at all (an outage, not a bad answer). */
  // Without reasoning by default: on cards the model reasoned to its token limit and never answered.
  // With it (reasoning = true), room to reason before the JSON.
  const answerOf = (user: string) => d.complete({ messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], maxTokens: 16384, ...(reasoning ? {} : { reasoning: { enabled: false } }) }).pipe(Effect.orElseSucceed(() => undefined))
  const ask = (user: string) => Effect.map(answerOf(user), (r) => r?.text)
  /** Why an answer has no text: how it ended, and where its tokens went. */
  const emptyWhy = (r: { readonly completionTokens?: number; readonly reasoningTokens?: number; readonly finishReason?: string }) =>
    r.finishReason === "length" ? `it stopped at its token limit (${r.completionTokens ?? "?"} tokens, ${r.reasoningTokens ?? "?"} of them reasoning)` : `it ended with ${r.finishReason ?? "no reason given"} (${r.completionTokens ?? "?"} tokens, ${r.reasoningTokens ?? "?"} of them reasoning)`
  const OUTAGE = "The driver model did not answer; the Triage Agent tries again on the next wake."
  const parseProposal = (text: string) => {
    const v = jsonIn(text) as { changes?: unknown; answers?: unknown; summary?: unknown } | undefined
    if (v === undefined || !Array.isArray(v.changes) || !v.changes.every((c) => typeof (c as { tool?: unknown })?.tool === "string")) return undefined
    return { changes: v.changes as Draft, answers: Array.isArray(v.answers) ? v.answers.filter((x): x is string => typeof x === "string") : [], summary: typeof v.summary === "string" ? v.summary : "" }
  }

  /** One card's proposal: from the model, dry-run over the draft so far; one retry with what was wrong. */
  const proposeFor = (st: StageView, card: string, who: string) =>
    Effect.gen(function* () {
      const entries = (yield* d.feedbackOf(st.journey).pipe(Effect.orElseSucceed(() => []))).filter((e) => e.on && cardOf(e.ref) === card)
      const say = (text: string) => quiet(d.log(who, `${st.journey}: ${text}`))
      yield* say(`drafting ${card} (${entries.length} feedback)`)
      const fresh = (st.results?.fresh ?? []).filter((f) => f.card === card)
      const step = yield* d.step(card, st.draft).pipe(Effect.orElseSucceed(() => null))
      const base = [
        `Journey: ${st.journey}`,
        "The card, as drafted so far:",
        "```gherkin",
        stepText(step),
        "```",
        "Feedback on it:",
        ...entries.flatMap((e) => [`- ${e.id} ${e.kind} (${e.severity}), by ${e.persona}: ${e.note}`, ...(e.operatorNote !== undefined ? [`  Operator's note: ${e.operatorNote}`] : [])]),
        ...fresh.map((f) => `- new ${f.kind} (${f.severity}): ${f.note}`),
        // Drafted again: what was wrong the last time.
        ...((st.proposals.find((p) => p.card === card)?.problems ?? []).length > 0 ? ["", `Your last proposal for this card failed: ${st.proposals.find((p) => p.card === card)!.problems!.join("; ")}. Avoid that.`] : []),
      ].join("\n")
      let prompt = base
      let last: { problems: ReadonlyArray<string>; proposal?: ReturnType<typeof parseProposal> } = { problems: [] }
      const tries: Array<Try> = []
      for (let attempt = 0; attempt < 2; attempt++) {
        const t0 = yield* clock
        const reply = yield* answerOf(prompt)
        const answer = reply?.text
        const ms = (yield* clock) - t0
        const tried = (problems: ReadonlyArray<string>) =>
          tries.push({ ms, tokensIn: reply?.promptTokens ?? 0, tokensOut: reply?.completionTokens ?? 0, reasoning: reply?.reasoningTokens ?? 0, ...(reply?.finishReason !== undefined ? { finish: reply.finishReason } : {}), problems })
        // No answer at all: the proposal stays waiting, and the operator is told why.
        if (answer === undefined) {
          yield* say(`${card}: ${OUTAGE}`)
          return yield* d.rehearsing({ journey: st.journey, note: OUTAGE })
        }
        const proposal = parseProposal(answer)
        if (proposal === undefined) {
          const excerpt = answer.replace(/\s+/g, " ").trim()
          yield* say(excerpt.length === 0 ? `${card}: the model gave no answer: ${emptyWhy(reply!)}` : `${card}: the model did not answer with the JSON asked for: “${excerpt.length > 160 ? `${excerpt.slice(0, 160)}…` : excerpt}”`)
          tried([excerpt.length === 0 ? "the model gave no answer" : "the model did not answer with the JSON asked for"])
          last = { problems: ["the Triage Agent could not draft a proposal"] }
          prompt = `${base}\n\nYour last answer was not the JSON asked for. Answer with the JSON only.`
          continue
        }
        const dry = yield* d.dryRun([...st.draft, ...proposal.changes]).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: ["the dry-run failed"], touched: [] })))
        last = { problems: dry.problems, proposal }
        tried(dry.problems)
        if (dry.ok) break
        yield* say(`${card}: the proposal failed its checks: ${dry.problems.join("; ")}`)
        prompt = `${base}\n\nYour last proposal did not pass the checks:\n${dry.problems.map((p) => `- ${p}`).join("\n")}\nFix it.`
      }
      const p = last.proposal
      yield* say(last.problems.length > 0 ? `${card} left out: ${last.problems.join("; ")}` : `${card} into the draft: ${p?.summary ?? ""}`)
      yield* d.propose({ journey: st.journey, card, ...(step !== null ? { title: step.title } : {}), tries, changes: p?.changes ?? [], answers: p?.answers ?? [], summary: p?.summary ?? "", ...(last.problems.length > 0 ? { problems: last.problems } : {}) })
    })

  /** Re-rehearse: check the whole draft, start a run over it (again, when one stopped), or read the one going. */
  const rehearse = (st: StageView, who: string) =>
    Effect.gen(function* () {
      const start = Effect.gen(function* () {
        const dry = yield* d.dryRun(st.draft).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: ["the dry-run failed"], touched: [] as ReadonlyArray<string>, cards: [] as ReadonlyArray<string> })))
        // Accepted one by one, the changes may not fit together: back to Refine before any run.
        if (!dry.ok) {
          yield* quiet(d.log(who, `${st.journey}: the drafted changes do not fit together: ${dry.problems.join("; ")}`))
          return yield* d.redraft({ journey: st.journey, problems: dry.problems })
        }
        const journey = (yield* d.journeys().pipe(Effect.orElseSucceed(() => []))).find((j) => j.name === st.journey)
        const focus = [...new Set([...(journey?.cards ?? []), ...dry.cards])]
        // Nothing to walk: an empty focus would walk the whole graph.
        if (focus.length === 0) return yield* d.rehearsed({ journey: st.journey, resolved: [], fresh: [], next: "plan", cards: dry.cards })
        const started: { readonly run?: string; readonly refused?: string } = yield* d.run({ strategy: "journey", focus, draft: st.draft, file: false }).pipe(Effect.orElseSucceed(() => ({ refused: "rehearse did not answer" })))
        if (started.run === undefined) {
          yield* quiet(d.log(who, `${st.journey}: re-rehearse waits: ${started.refused ?? "rehearse did not start"}`))
          return yield* d.rehearsing({ journey: st.journey, clear: true, note: `waits: ${started.refused ?? "rehearse did not start"}` })
        }
        yield* quiet(d.log(who, `${st.journey}: re-rehearsing on ${focus.length} cards (run ${started.run})`))
        return yield* d.rehearsing({ journey: st.journey, run: started.run, cards: dry.cards })
      })
      if (st.run === undefined) return yield* start
      const r = yield* d.result(st.run).pipe(Effect.orElseSucceed(() => ({ status: "unknown", findings: [] })))
      if (r.status === "running") return
      // A run that stopped, or is gone: start another.
      if (r.status !== "done") return yield* start
      const entries = yield* d.feedbackOf(st.journey).pipe(Effect.orElseSucceed(() => []))
      const same = (card: string, kind: string) => r.findings.some((f) => f.card === card && f.kind === kind)
      const resolved = entries.filter((e) => e.on && !same(cardOf(e.ref), e.kind)).map((e) => e.id)
      // Fresh: new to this journey — not an entry already (on or off), not one the operator skipped.
      const known = (f: { card: string; kind: string }) => entries.some((e) => cardOf(e.ref) === f.card && e.kind === f.kind) || (st.dismissed ?? []).some((x) => x.card === f.card && x.kind === f.kind)
      const fresh = r.findings.filter((f) => f.on && !known(f)).map(({ on: _, ...f }) => f)
      yield* quiet(d.log(who, `${st.journey}: re-rehearsed: ${resolved.length} resolved, ${fresh.length} new`))
      // On to Plan either way: new findings are named there, and the operator refines again or accepts.
      yield* d.rehearsed({ journey: st.journey, resolved, fresh, next: "plan", ...(st.cards !== undefined ? { cards: st.cards } : {}) })
    })

  /** Plan: a title and steps for the accepted changes (a plain one when the model does not answer). */
  const draftPlan = (st: StageView, who: string) =>
    Effect.gen(function* () {
      const accepted = st.proposals.filter((p) => p.status === "accepted")
      const text = yield* ask(
        [`Journey: ${st.journey}`, "Accepted changes:", ...accepted.map((p) => `- ${p.card}: ${p.summary}`), "", 'Write the plan: {"title":"at most 8 words","steps":["one line per step"]}. JSON only.'].join("\n"),
      )
      if (text === undefined) return yield* d.rehearsing({ journey: st.journey, note: OUTAGE })
      const v = jsonIn(text) as { title?: unknown; steps?: unknown } | undefined
      const title = typeof v?.title === "string" && v.title.length > 0 ? v.title : `${st.journey}: ${accepted.length} card${accepted.length === 1 ? "" : "s"} refined`
      const steps = Array.isArray(v?.steps) && v.steps.every((x) => typeof x === "string") ? (v.steps as ReadonlyArray<string>) : accepted.map((p) => `${p.card}: ${p.summary}`)
      yield* quiet(d.log(who, `${st.journey}: plan drafted: ${title}`))
      yield* d.drafted({ journey: st.journey, title, steps })
    })

  /** One pass over a journey: its waiting cards one by one (each over the draft as it now stands), then its re-rehearse or its plan. */
  const pass = (slot: Slot, journey: string) =>
    Effect.gen(function* () {
      const first = (yield* d.stages().pipe(Effect.orElseSucceed(() => []))).find((x) => x.journey === journey)
      if (first === undefined) return
      if (first.stage === "refine")
        for (const p of first.proposals.filter((x) => x.status === "waiting")) {
          const now = (yield* d.stages().pipe(Effect.orElseSucceed(() => []))).find((x) => x.journey === journey)
          if (paused || now === undefined || now.stage !== "refine" || !now.proposals.some((x) => x.card === p.card && x.status === "waiting")) break
          yield* quiet(d.status(slot.id, `${journey}: drafting ${p.card}`))
          yield* at(slot, { journey, card: p.card, since: yield* clock })
          yield* proposeFor(now, p.card, slot.id)
        }
      const st = (yield* d.stages().pipe(Effect.orElseSucceed(() => []))).find((x) => x.journey === journey)
      if (paused || st === undefined) return
      if (st.stage === "rehearse") {
        // Since when it waits on this journey's run (first seen, if it started before this process).
        if (!runsSince.has(journey)) runsSince.set(journey, yield* clock)
        yield* quiet(d.status(slot.id, `${journey}: re-rehearsing`))
        yield* at(slot, { journey, card: "", since: runsSince.get(journey)! })
        yield* rehearse(st, slot.id)
      } else runsSince.delete(journey)
      const after = (yield* d.stages().pipe(Effect.orElseSucceed(() => []))).find((x) => x.journey === journey)
      if (after !== undefined && after.stage === "plan" && after.plan === undefined && after.draft.length > 0) {
        yield* quiet(d.status(slot.id, `${journey}: drafting the plan`))
        yield* draftPlan(after, slot.id)
      }
    }).pipe(Effect.catchCause(() => Effect.void))

  // The workers: each takes the next journey in line and works it, pass by pass, until it needs nothing more of them.
  const slots: Array<Slot> = Array.from({ length: Math.max(1, workers) }, (_, i) => ({ id: `triage-${i + 1}`, busy: false }))
  const running = new Set<Fiber.Fiber<void, never>>()
  const needsWork = (s: StageView) => (s.stage === "refine" && s.proposals.some((p) => p.status === "waiting")) || s.stage === "rehearse" || (s.stage === "plan" && s.plan === undefined && s.draft.length > 0)
  // One assignment at a time: two wakes close together must not give a journey to two workers.
  const lock = Effect.runSync(Semaphore.make(1))
  const tick: Effect.Effect<void> = Effect.gen(function* () {
    if (paused) return
    const stages = yield* d.stages().pipe(Effect.orElseSucceed(() => []))
    // A re-rehearse a round left behind (d, Refine again) walks an old draft: stop it, forget it.
    for (const s of stages)
      if (s.dropRun !== undefined) {
        yield* quiet(d.stop(s.dropRun))
        yield* quiet(d.rehearsing({ journey: s.journey, dropped: true }))
      }
    const line = stages.filter(needsWork).sort((a, b) => (a.queued ?? 0) - (b.queued ?? 0))
    // A worker whose journey needs nothing more lets it go.
    for (const w of slots)
      if (w.journey !== undefined && !w.busy && !line.some((s) => s.journey === w.journey)) {
        const done = w.journey
        w.journey = undefined
        w.at = undefined
        yield* quiet(d.assign(done))
        yield* quiet(d.worker(w.id, undefined))
      }
    // The next in line go to free workers.
    for (const s of line) {
      if (slots.some((w) => w.journey === s.journey)) continue
      const w = slots.find((x) => x.journey === undefined)
      if (w === undefined) break
      w.journey = s.journey
      yield* quiet(d.assign(s.journey, w.id))
      yield* quiet(d.worker(w.id, s.journey))
    }
    // Every worker with a journey and nothing in flight makes a pass, in the background.
    for (const w of slots)
      if (w.journey !== undefined && !w.busy) {
        w.busy = true
        const journey = w.journey
        const fiber = yield* Effect.forkDetach(
          pass(w, journey).pipe(
            Effect.ensuring(Effect.sync(() => (w.busy = false))),
            Effect.ensuring(at(w, undefined)),
          ),
        )
        running.add(fiber)
        fiber.addObserver(() => running.delete(fiber))
      }
    yield* quiet(d.render)
  }).pipe(Effect.catchCause(() => Effect.void), lock.withPermits(1))
  return {
    tick,
    /** Waits for every pass in flight (tests; a shutdown). */
    idle: Effect.suspend(() => Fiber.joinAll([...running])).pipe(Effect.asVoid, Effect.catchCause(() => Effect.void)),
    /** p: pause (after the cards in flight) or resume; answers whether it is paused now. */
    pause: () => (paused = !paused),
    /** What the views show beside the stages: each worker, whether paused. */
    state: () => ({ workers: slots.map((w) => ({ id: w.id, ...(w.journey !== undefined ? { journey: w.journey } : {}), ...(w.at !== undefined ? { working: w.at } : {}) })), paused }),
  }
}
