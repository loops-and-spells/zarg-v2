import { Effect, Semaphore } from "effect"
import { parseRef } from "@zarg/entities"

type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
type Proposal = { readonly card: string; readonly changes: Draft; readonly answers: ReadonlyArray<string>; readonly summary: string; readonly status: "waiting" | "proposed" | "accepted" | "skipped"; readonly problems?: ReadonlyArray<string> }
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
}
type OnEntry = { readonly id: string; readonly ref: string; readonly kind: string; readonly severity: string; readonly note: string; readonly persona: string }
type Step = { readonly card: string; readonly title: string; readonly given: string; readonly when: string; readonly thens: ReadonlyArray<string>; readonly by?: ReadonlyArray<string> } | null

/** The Triage Agent's powers, as plain functions (the plugin wires them to its contracts; tests stub them). */
export interface TriageDeps {
  readonly stages: () => Effect.Effect<ReadonlyArray<StageView>, unknown>
  readonly feedbackOf: (journey: string) => Effect.Effect<ReadonlyArray<OnEntry>, unknown>
  readonly journeys: () => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string; readonly cards: ReadonlyArray<string> }>, unknown>
  readonly step: (card: string, draft: Draft) => Effect.Effect<Step, unknown>
  readonly dryRun: (draft: Draft) => Effect.Effect<{ readonly ok: boolean; readonly problems: ReadonlyArray<string>; readonly touched: ReadonlyArray<string> }, unknown>
  readonly complete: (req: { readonly messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>; readonly maxTokens?: number }) => Effect.Effect<{ readonly text: string }, unknown>
  readonly propose: (p: { readonly journey: string; readonly card: string; readonly changes: Draft; readonly answers: ReadonlyArray<string>; readonly summary: string; readonly problems?: ReadonlyArray<string> }) => Effect.Effect<void, unknown>
  readonly rehearsing: (p: { readonly journey: string; readonly run?: string; readonly cards?: ReadonlyArray<string>; readonly note?: string }) => Effect.Effect<void, unknown>
  readonly rehearsed: (p: { readonly journey: string; readonly resolved: ReadonlyArray<string>; readonly fresh: ReadonlyArray<Fresh>; readonly next: "plan" | "refine"; readonly cards?: ReadonlyArray<string> }) => Effect.Effect<void, unknown>
  readonly drafted: (p: { readonly journey: string; readonly title: string; readonly steps: ReadonlyArray<string> }) => Effect.Effect<void, unknown>
  readonly run: (p: { readonly focus: ReadonlyArray<string>; readonly draft: Draft; readonly file: false }) => Effect.Effect<{ readonly run?: string; readonly refused?: string }, unknown>
  readonly result: (run: string) => Effect.Effect<{ readonly status: string; readonly findings: ReadonlyArray<Fresh & { readonly on: boolean }> }, unknown>
  /** The agent's row: what it does now. */
  readonly status: (text: string) => Effect.Effect<void, unknown>
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
  'add-state {"text":"…"}: a new sentence',
  'add-card {"title":"Who does what","when":"the one action","by":[{"name":"Operator"}],"arrives":{"id":"S-0001"},"then":[{"text":"…"}]}: a new card (states by {id} or {text}; 1-5 thens)',
  'link {"from":"UX-0001","edge":"then","to":"S-0009"} / unlink {...}: add or remove one of a card\'s edges',
].join("\n")
const SYSTEM = [
  "You refine a product's requirements: Gherkin cards (Given, When, Then) that testers found problems with.",
  "Propose the smallest change to the graph that answers the feedback, as gherkin tool calls in order. Clauses at most 15 words; never 'if' (one card per case).",
  `Tools:\n${TOOLS}`,
  'Answer with JSON only: {"changes":[{"tool":"…","params":{…}}],"answers":["F-…"],"summary":"one sentence for the operator"}.',
].join("\n\n")
const stepText = (s: Step) => (s === null ? "(this card is not in the graph)" : [`${s.card} ${s.title}`, ...(s.by !== undefined && s.by.length > 0 ? [`By    ${s.by.join(", ")}`] : []), `Given ${s.given}`, `When  ${s.when}`, ...s.thens.map((t, i) => `${i === 0 ? "Then" : "And "}  ${t}`)].join("\n"))
const cardOf = (ref: string) => parseRef(ref)?.id ?? ref

/** The Triage Agent: the agent's part of each journey's stage, whenever the core wakes it. */
export const makeTriage = (d: TriageDeps) => {
  const quiet = <A>(e: Effect.Effect<A, unknown>) => Effect.ignore(e)
  const ask = (user: string) => Effect.map(d.complete({ messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], maxTokens: 4096 }).pipe(Effect.orElseSucceed(() => ({ text: "" }))), (r) => r.text)
  const parseProposal = (text: string) => {
    const v = jsonIn(text) as { changes?: unknown; answers?: unknown; summary?: unknown } | undefined
    if (v === undefined || !Array.isArray(v.changes) || !v.changes.every((c) => typeof (c as { tool?: unknown })?.tool === "string")) return undefined
    return { changes: v.changes as Draft, answers: Array.isArray(v.answers) ? v.answers.filter((x): x is string => typeof x === "string") : [], summary: typeof v.summary === "string" ? v.summary : "" }
  }

  /** One card's proposal: from the model, dry-run over the draft so far; one retry with what was wrong. */
  const proposeFor = (st: StageView, card: string) =>
    Effect.gen(function* () {
      const entries = (yield* d.feedbackOf(st.journey).pipe(Effect.orElseSucceed(() => []))).filter((e) => cardOf(e.ref) === card)
      const fresh = (st.results?.fresh ?? []).filter((f) => f.card === card)
      const step = yield* d.step(card, st.draft).pipe(Effect.orElseSucceed(() => null))
      const base = [
        `Journey: ${st.journey}`,
        "The card, as drafted so far:",
        "```gherkin",
        stepText(step),
        "```",
        "Feedback on it:",
        ...entries.map((e) => `- ${e.id} ${e.kind} (${e.severity}), by ${e.persona}: ${e.note}`),
        ...fresh.map((f) => `- new ${f.kind} (${f.severity}): ${f.note}`),
      ].join("\n")
      let prompt = base
      let last: { problems: ReadonlyArray<string>; proposal?: ReturnType<typeof parseProposal> } = { problems: [] }
      for (let attempt = 0; attempt < 2; attempt++) {
        const proposal = parseProposal(yield* ask(prompt))
        if (proposal === undefined) {
          last = { problems: ["the Triage Agent could not draft a proposal: skip this card"] }
          prompt = `${base}\n\nYour last answer was not the JSON asked for. Answer with the JSON only.`
          continue
        }
        const dry = yield* d.dryRun([...st.draft, ...proposal.changes]).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: ["the dry-run failed"], touched: [] })))
        last = { problems: dry.problems, proposal }
        if (dry.ok) break
        prompt = `${base}\n\nYour last proposal did not pass the checks:\n${dry.problems.map((p) => `- ${p}`).join("\n")}\nFix it.`
      }
      const p = last.proposal
      yield* d.propose({ journey: st.journey, card, changes: p?.changes ?? [], answers: p?.answers ?? [], summary: p?.summary ?? "", ...(last.problems.length > 0 ? { problems: last.problems } : {}) })
    })

  /** Re-rehearse: start a run over the draft, or read the one going. */
  const rehearse = (st: StageView) =>
    Effect.gen(function* () {
      if (st.run === undefined) {
        const dry = yield* d.dryRun(st.draft).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: [], touched: [] as ReadonlyArray<string> })))
        const journey = (yield* d.journeys().pipe(Effect.orElseSucceed(() => []))).find((j) => j.name === st.journey)
        const focus = [...new Set([...(journey?.cards ?? []), ...dry.touched.filter((id) => /^UX-/.test(id))])]
        const started: { readonly run?: string; readonly refused?: string } = yield* d.run({ focus, draft: st.draft, file: false }).pipe(Effect.orElseSucceed(() => ({ refused: "rehearse did not answer" })))
        if (started.run === undefined) return yield* d.rehearsing({ journey: st.journey, note: `waits: ${started.refused ?? "rehearse did not start"}` })
        return yield* d.rehearsing({ journey: st.journey, run: started.run, cards: dry.touched })
      }
      const r = yield* d.result(st.run).pipe(Effect.orElseSucceed(() => ({ status: "unknown", findings: [] })))
      if (r.status === "running") return
      if (r.status !== "done") return yield* d.rehearsing({ journey: st.journey, note: `the re-rehearse ${r.status === "stopped" ? "stopped" : "is gone"}: it starts again on the next wake` })
      const entries = yield* d.feedbackOf(st.journey).pipe(Effect.orElseSucceed(() => []))
      const same = (card: string, kind: string) => r.findings.some((f) => f.card === card && f.kind === kind)
      const resolved = entries.filter((e) => !same(cardOf(e.ref), e.kind)).map((e) => e.id)
      const fresh = r.findings.filter((f) => f.on && !entries.some((e) => cardOf(e.ref) === f.card && e.kind === f.kind)).map(({ on: _, ...f }) => f)
      yield* d.rehearsed({ journey: st.journey, resolved, fresh, next: fresh.length > 0 ? "refine" : "plan", ...(st.cards !== undefined ? { cards: st.cards } : {}) })
    })

  /** Plan: a title and steps for the accepted changes (a plain one when the model does not answer). */
  const draftPlan = (st: StageView) =>
    Effect.gen(function* () {
      const accepted = st.proposals.filter((p) => p.status === "accepted")
      const text = yield* ask(
        [`Journey: ${st.journey}`, "Accepted changes:", ...accepted.map((p) => `- ${p.card}: ${p.summary}`), "", 'Write the plan: {"title":"at most 8 words","steps":["one line per step"]}. JSON only.'].join("\n"),
      )
      const v = jsonIn(text) as { title?: unknown; steps?: unknown } | undefined
      const title = typeof v?.title === "string" && v.title.length > 0 ? v.title : `${st.journey}: ${accepted.length} card${accepted.length === 1 ? "" : "s"} refined`
      const steps = Array.isArray(v?.steps) && v.steps.every((x) => typeof x === "string") ? (v.steps as ReadonlyArray<string>) : accepted.map((p) => `${p.card}: ${p.summary}`)
      yield* d.drafted({ journey: st.journey, title, steps })
    })

  // One pass at a time: two wakes close together must not propose twice or start two runs.
  const lock = Effect.runSync(Semaphore.make(1))
  const tick = Effect.gen(function* () {
    for (const st of yield* d.stages().pipe(Effect.orElseSucceed(() => []))) {
      if (st.stage === "refine")
        for (const p of st.proposals.filter((x) => x.status === "waiting")) {
          yield* quiet(d.status(`${st.journey}: proposing for ${p.card}`))
          yield* proposeFor(st, p.card)
        }
      if (st.stage === "rehearse") yield* rehearse(st)
      if (st.stage === "plan" && st.plan === undefined) {
        yield* quiet(d.status(`${st.journey}: drafting the plan`))
        yield* draftPlan(st)
      }
    }
  }).pipe(Effect.catchCause(() => Effect.void), lock.withPermits(1))
  return { tick }
}
