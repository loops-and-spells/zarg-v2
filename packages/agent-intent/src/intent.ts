import { Effect, Semaphore } from "effect"
import { dependencies, fold, type Folded, jsonIn, merge, type Unit } from "@zarg/fold"
import { type Checkpoint, due, type Entry, type JourneyInfo, type Statement } from "./checkpoint"

type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
type Option = { readonly id: string; readonly label: string; readonly recommended?: boolean }
type Topic = { readonly kind: string; readonly key: string; readonly title: string; readonly why: string; readonly about: ReadonlyArray<string>; readonly answers: ReadonlyArray<Option>; readonly evidence?: string }

/** The Intent Agent's powers, as plain functions (the plugin wires them to its contracts; tests stub them). */
export interface IntentDeps {
  readonly statements: () => Effect.Effect<ReadonlyArray<Statement>, unknown>
  readonly journeys: () => Effect.Effect<ReadonlyArray<JourneyInfo>, unknown>
  /** A scenario as Gherkin text, as it is now. */
  readonly scene: (scenario: string) => Effect.Effect<string, unknown>
  readonly code: (scenario: string) => Effect.Effect<ReadonlyArray<{ readonly file: string; readonly line: number; readonly text: string }>, unknown>
  readonly dryRun: (draft: Draft) => Effect.Effect<{ readonly ok: boolean; readonly problems: ReadonlyArray<string>; readonly scenarios?: ReadonlyArray<string> }, unknown>
  readonly complete: (req: { readonly messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>; readonly maxTokens?: number; readonly reasoning?: { readonly enabled: boolean } }) => Effect.Effect<{ readonly text: string }, unknown>
  /** An entity's version now (null: gone). */
  readonly version: (ref: string) => Effect.Effect<string | null, unknown>
  readonly plan: (p: { readonly title: string; readonly journey: string; readonly scenarios: ReadonlyArray<{ readonly ref: string }>; readonly changes: Draft; readonly feedback: ReadonlyArray<string>; readonly steps: ReadonlyArray<string>; readonly after?: ReadonlyArray<string>; readonly serves: string }) => Effect.Effect<{ readonly id: string }, unknown>
  readonly dropServing: (statement: string) => Effect.Effect<{ readonly ids: ReadonlyArray<string> }, unknown>
  /** Of these plan ids, the ones dropped (or gone) from the Backlog. */
  readonly dropped: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, unknown>
  readonly post: (t: Topic) => Effect.Effect<string, unknown>
  readonly settle: (topic: string, why: string) => Effect.Effect<void, unknown>
  readonly load: Effect.Effect<Checkpoint, unknown>
  readonly save: (cp: Checkpoint) => Effect.Effect<void, unknown>
  readonly log: (text: string) => Effect.Effect<void, unknown>
  /** Draw the agent's view again. */
  readonly render: Effect.Effect<void, unknown>
}

export type RoundView = { readonly id: string; readonly title: string; readonly state: "drafting" | "planned" | "asked" | "left" | "nothing" | "waiting"; readonly detail: string; readonly plans: ReadonlyArray<string> }

const TOOLS = [
  'add-scenario {"title":"Who does what","when":"the one action","by":[{"name":"Operator"}],"arrives":{"id":"ST-0001"},"then":[{"text":"…"}],"given":[]}: a new scenario (1-5 thens)',
  'edit-scenario {"id":"S-0001","title":"…","when":"…"}: change a scenario\'s title or When',
  'edit-state {"id":"ST-0002","text":"…"}: reword a Given/Then sentence (every scenario using it changes)',
  'link {"scenario":"S-0001","edge":"then","state":{"text":"…"}}: add a then (given, arrives likewise); {"scenario":"S-0001","edge":"in","journey":{"id":"J-0001"}} puts it in a journey',
  'unlink {"scenario":"S-0001","edge":"then","state":"ST-0002"}: remove one',
  'add-journey {"name":"…"}: a new journey (then link its scenarios with in)',
  'link {"edge":"serves","journey":{"id":"J-0001"},"outcome":"O-0001"}: the journey delivers the outcome',
  'link {"edge":"bounds","constraint":"K-0001","journey":{"id":"J-0001"}}: the constraint applies to a journey (or "scenario":"S-0001")',
].join("\n")
export const SYSTEM = [
  "You turn a product's intent into its requirements: Gherkin scenarios (Given, When, Then) in journeys.",
  'One statement of the intent changed, is new, or no journey delivers it yet. Propose the smallest change to the graph that makes the journeys deliver it (an outcome) or respect it (a constraint), as gherkin tool calls in order, grouped by the scenario each changes ("new:<short name>" for a new one).',
  "Clauses at most 15 words, never 'if' (one scenario per case). Titles start with the persona's name. Refer to states that exist by id; name every new state by text.",
  `Tools:\n${TOOLS}`,
  "When the journeys already deliver it, answer no units. When it needs the operator's choice (which journey, which of two meanings, a conflict with a scenario), answer an ask with 2-4 options instead of guessing.",
  'Answer with JSON only: {"units":[{"scenario":"S-0001","title":"…","summary":"one sentence","changes":[{"tool":"…","params":{…}}]}],"steps":["one line per step, for the operator"],"ask":null or {"question":"…","options":[{"id":"…","label":"…"}]}}.',
].join("\n\n")
const JOURNEY_SYSTEM = [
  "A journey of a product serves no outcome of its intent. Say which outcomes it delivers (one or more ids), or ask the operator when none fits.",
  'Answer with JSON only: {"serves":["O-0001"],"ask":null or {"question":"…","options":[{"id":"…","label":"…"}]}}.',
].join("\n\n")
const TRIES = 3
const LEAVE = { id: "leave", label: "Leave it" } as const

/** A model's ask: the question and its options (2-4 the model offered). */
const askOf = (a: unknown): { readonly question: string; readonly options: ReadonlyArray<Option> } | undefined => {
  const x = a as { question?: unknown; options?: unknown } | null | undefined
  if (x === null || x === undefined || typeof x.question !== "string" || !Array.isArray(x.options)) return undefined
  return { question: x.question, options: (x.options as ReadonlyArray<{ id?: unknown; label?: unknown }>).filter((o) => typeof o?.id === "string" && typeof o?.label === "string").map((o) => ({ id: String(o.id), label: String(o.label) })) }
}

/** The Intent Agent: rounds over what is due, one at a time, whenever the core wakes it. */
export const makeIntent = (d: IntentDeps, reasoning = false) => {
  const quiet = <A>(e: Effect.Effect<A, unknown>) => Effect.ignore(e)
  const views = new Map<string, RoundView>()
  const show = (v: RoundView) => Effect.andThen(Effect.sync(() => void views.set(v.id, v)), quiet(d.render))
  // What the last model call came to: its failure, or the text it answered (the log says which).
  let last: { readonly failed: string } | { readonly text: string } = { text: "" }
  const ask = (system: string, user: string) =>
    d.complete({ messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 16384, ...(reasoning ? {} : { reasoning: { enabled: false } }) }).pipe(
      Effect.map((r) => ((last = { text: r.text }), r.text)),
      Effect.catch((e: unknown) => Effect.sync(() => ((last = { failed: String((e as { message?: unknown })?.message ?? e) }), undefined))),
    )
  const update = (f: (cp: Checkpoint) => Checkpoint) => Effect.flatMap(d.load, (cp) => d.save(f(cp)))
  const setStatement = (id: string, e: Entry | undefined) =>
    update((cp) => {
      const statements = { ...cp.statements }
      if (e === undefined) delete statements[id]
      else statements[id] = e
      return { ...cp, statements }
    })
  const setJourney = (id: string, e: Entry) => update((cp) => ({ ...cp, journeys: { ...cp.journeys, [id]: e } }))
  const OUTAGE = (id: string) =>
    `${id}: ${"failed" in last ? `the driver model failed: ${last.failed}` : `the driver model did not answer with JSON (it began: ${JSON.stringify(last.text.trim().slice(0, 80))})`}; the Intent Agent tries again on the next wake`

  /** The context a round reads: the statement, its intent, its journeys with their scenarios and code. */
  const contextOf = (s: Statement, journeys: ReadonlyArray<JourneyInfo>) =>
    Effect.gen(function* () {
      const mine = journeys.filter((j) => s.journeys.includes(j.id))
      const blocks = yield* Effect.forEach(mine, (j) =>
        Effect.gen(function* () {
          const scenes = yield* Effect.forEach(j.scenarios, (c) =>
            Effect.gen(function* () {
              const text = yield* d.scene(c).pipe(Effect.orElseSucceed(() => `${c} (not in the graph)`))
              const code = yield* d.code(c).pipe(Effect.orElseSucceed(() => []))
              return [text, ...(code.length > 0 ? ["What zarg does now:", ...code.slice(0, 2).map((x) => `${x.file}:${x.line}\n${x.text.split("\n").slice(0, 20).join("\n")}`)] : [])].join("\n")
            }),
          )
          return [`## ${j.id} ${j.name}`, ...scenes].join("\n\n")
        }),
      )
      return [
        `Intent ${s.intent.id}: ${s.intent.title}`,
        ...(s.intent.problem !== undefined ? [`Problem: ${s.intent.problem}`] : []),
        "",
        `${s.id} (${s.kind}): ${s.text}`,
        "",
        mine.length > 0 ? (s.kind === "outcome" ? "Journeys that serve it:" : "Journeys it bounds:") : "No journey serves it yet. Journeys:",
        ...(mine.length > 0 ? blocks : journeys.map((j) => `- ${j.id} ${j.name}`)),
      ].join("\n")
    })

  /** Parsed units, steps and an ask; undefined when the answer holds no units list (an outage for this round). */
  const parse = (text: string | undefined) => {
    if (text === undefined) return undefined
    const v = jsonIn(text) as { units?: unknown; steps?: unknown; ask?: unknown } | undefined
    if (v === undefined || !Array.isArray(v.units)) return undefined
    const units = (v.units as ReadonlyArray<Record<string, unknown>>)
      .filter((u) => typeof u?.scenario === "string" && Array.isArray(u.changes))
      .map((u): Unit => ({ scenario: String(u.scenario), title: String(u.title ?? u.scenario), summary: String(u.summary ?? ""), changes: u.changes as Draft, answers: [] }))
    return { units, steps: Array.isArray(v.steps) ? v.steps.filter((x): x is string => typeof x === "string") : [], ask: askOf(v.ask) }
  }

  /** The round's units folded into plans, each dry-run over the plans it waits on (one that fails merges into them). */
  const plansOf = (units: ReadonlyArray<Unit>) =>
    Effect.gen(function* () {
      let plans: Array<Folded> = fold(units, dependencies(units))
      const changesOf = (p: Folded) => p.units.flatMap((u) => units[u]!.changes)
      const before = (k: number): ReadonlyArray<number> => [...new Set(plans[k]!.after.flatMap((j) => [...before(j), j]))].sort((x, y) => x - y)
      for (let pass = 0; pass < units.length && plans.length > 1; pass++) {
        let bad: number | undefined
        for (let k = 0; k < plans.length && bad === undefined; k++) {
          const dry = yield* d.dryRun([...before(k).flatMap((j) => changesOf(plans[j]!)), ...changesOf(plans[k]!)]).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: [] })))
          if (!dry.ok) bad = k
        }
        if (bad === undefined) break
        plans = merge(plans, bad)
      }
      return plans.map((p) => ({ title: p.title, steps: p.steps, changes: changesOf(p), scenarios: p.units.map((u) => units[u]!.scenario).filter((c) => /^S-\d/.test(c)), after: p.after }))
    })

  // @scenario S-0103 S-0104
  /** One statement's round: draft (up to TRIES), ask or file, checkpoint; nothing filed when it changed meanwhile. */
  const statementRound = (s: Statement, journeys: ReadonlyArray<JourneyInfo>, decision: string | undefined) =>
    Effect.gen(function* () {
      yield* show({ id: s.id, title: s.text, state: "drafting", detail: "", plans: [] })
      const context = yield* contextOf(s, journeys)
      let problems: ReadonlyArray<string> = []
      for (let t = 1; t <= TRIES; t++) {
        const user = [context, ...(decision !== undefined ? ["", `The operator decided: ${decision}`] : []), ...(problems.length > 0 ? ["", "Your last answer failed its checks:", ...problems.map((p) => `- ${p}`), "Fix them."] : [])].join("\n")
        const r = parse(yield* ask(SYSTEM, user))
        if (r === undefined) {
          yield* quiet(d.log(OUTAGE(s.id)))
          yield* show({ id: s.id, title: s.text, state: "waiting", detail: "the driver model did not answer", plans: [] })
          return "outage" as const
        }
        // @scenario S-0104
        if (r.ask !== undefined && r.units.length === 0) {
          const options = [...r.ask.options, LEAVE]
          const topic = yield* d.post({ kind: "ask", key: `decide:${s.id}`, title: r.ask.question, why: `intent ${s.intent.id}`, about: [s.id], answers: options })
          yield* setStatement(s.id, { version: s.version, state: "asked", topic, options })
          return yield* show({ id: s.id, title: s.text, state: "asked", detail: r.ask.question, plans: [] })
        }
        if (r.units.length === 0) {
          yield* setStatement(s.id, { version: s.version, state: "nothing" })
          yield* quiet(d.log(`${s.id}: the journeys already deliver it`))
          return yield* show({ id: s.id, title: s.text, state: "nothing", detail: "the journeys already deliver it", plans: [] })
        }
        const dry = yield* d.dryRun(r.units.flatMap((u) => u.changes)).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: ["the dry run could not run"] })))
        if (!dry.ok) {
          problems = dry.problems
          continue
        }
        // The statement as it is now: changed meanwhile, nothing is filed and the next tick drafts it again.
        const now = (yield* d.statements()).find((x) => x.id === s.id)
        if (now === undefined || now.version !== s.version) {
          yield* quiet(d.log(`${s.id} changed while drafting: drafting it again on the next wake`))
          return yield* show({ id: s.id, title: s.text, state: "waiting", detail: "changed while drafting", plans: [] })
        }
        const serves = `gherkin/${s.kind}:${s.id}@${s.version}`
        // The plan's journey: one serving (or bounded by) the statement, else the one holding a scenario it changes.
        const journey = (journeys.find((j) => s.journeys.includes(j.id)) ?? journeys.find((j) => r.units.some((u) => j.scenarios.includes(u.scenario))))?.name ?? ""
        // @scenario S-0103
        const ids: Array<string> = []
        const plans = yield* plansOf(r.units)
        for (const p of plans) {
          const scenarios = yield* Effect.forEach(p.scenarios, (c) => Effect.map(d.version(`gherkin/scenario:${c}`).pipe(Effect.orElseSucceed(() => null)), (v) => (v === null ? [] : [{ ref: `gherkin/scenario:${c}@${v}` }])))
          const after = p.after.flatMap((k) => (ids[k] !== undefined ? [ids[k]!] : []))
          const { id } = yield* d.plan({ title: p.title, journey, scenarios: scenarios.flat(), changes: p.changes, feedback: [], steps: plans.length === 1 && r.steps.length > 0 ? r.steps : p.steps, serves, ...(after.length > 0 ? { after } : {}) })
          ids.push(id)
        }
        yield* setStatement(s.id, { version: s.version, state: "planned", plans: ids })
        yield* quiet(d.log(`${s.id}: ${ids.length} plan${ids.length === 1 ? "" : "s"} to the Backlog: ${ids.join(", ")}`))
        return yield* show({ id: s.id, title: s.text, state: "planned", detail: r.steps.join("\n"), plans: ids })
      }
      // @scenario S-0104
      const options = [{ id: "again", label: "Draft again", recommended: true }, LEAVE]
      const topic = yield* d.post({ kind: "ask", key: `left:${s.id}`, title: `${s.id} could not be drafted: ${s.text}`, why: `intent ${s.intent.id}`, about: [s.id], answers: options, evidence: problems.join("\n") })
      yield* setStatement(s.id, { version: s.version, state: "left", topic, options })
      return yield* show({ id: s.id, title: s.text, state: "left", detail: problems.join("\n"), plans: [] })
    })

  /** A journey serving nothing: which outcomes it serves, as one plan of serves links (or a question). */
  const journeyRound = (j: JourneyInfo, statements: ReadonlyArray<Statement>) =>
    Effect.gen(function* () {
      yield* show({ id: j.id, title: j.name, state: "drafting", detail: "", plans: [] })
      const scenes = yield* Effect.forEach(j.scenarios, (c) => d.scene(c).pipe(Effect.orElseSucceed(() => c)))
      const outcomes = statements.filter((s) => s.kind === "outcome")
      const text = yield* ask(JOURNEY_SYSTEM, [`Journey ${j.id} ${j.name}:`, ...scenes, "", "Outcomes:", ...outcomes.map((o) => `- ${o.id}: ${o.text}`)].join("\n\n"))
      const v = text === undefined ? undefined : (jsonIn(text) as { serves?: unknown; ask?: unknown } | undefined)
      if (v === undefined) {
        yield* quiet(d.log(OUTAGE(j.id)))
        yield* show({ id: j.id, title: j.name, state: "waiting", detail: "the driver model did not answer", plans: [] })
        return "outage" as const
      }
      const serves = Array.isArray(v.serves) ? v.serves.filter((x): x is string => typeof x === "string" && outcomes.some((o) => o.id === x)) : []
      if (serves.length === 0) {
        // The answers are the outcomes themselves: an answer names one, and the plan links it (the model's ids could be anything).
        const q = askOf(v.ask)?.question ?? `${j.name} serves no outcome: which does it deliver?`
        const options = [...outcomes.slice(0, 9).map((o) => ({ id: o.id, label: `${o.id}: ${o.text}` })), LEAVE]
        const topic = yield* d.post({ kind: "ask", key: `serve:${j.id}`, title: q, why: "a journey serving no outcome", about: [j.id], answers: options })
        yield* setJourney(j.id, { version: j.version, state: "asked", topic, options })
        return yield* show({ id: j.id, title: j.name, state: "asked", detail: q, plans: [] })
      }
      const first = outcomes.find((o) => o.id === serves[0])!
      const { id } = yield* d.plan({
        title: `${j.name} serves ${serves.join(", ")}`,
        journey: j.name,
        scenarios: [],
        changes: serves.map((o) => ({ tool: "link", params: { edge: "serves", journey: { id: j.id }, outcome: o } })),
        feedback: [],
        steps: serves.map((o) => `${j.name} delivers ${o}: ${outcomes.find((x) => x.id === o)!.text}`),
        serves: `gherkin/outcome:${first.id}@${first.version}`,
      })
      yield* setJourney(j.id, { version: j.version, state: "planned", plans: [id] })
      return yield* show({ id: j.id, title: j.name, state: "planned", detail: `serves ${serves.join(", ")}`, plans: [id] })
    })

  // One tick at a time (the core wakes it on every graph write and backlog change); a wake while one runs queues one more pass.
  const lock = Effect.runSync(Semaphore.make(1))
  let queued = false
  const exclusive = <A, E>(e: Effect.Effect<A, E>) => lock.withPermits(1)(e)

  /** Everything due, one round at a time; the first outage ends the pass (the next wake tries again). */
  const pass = Effect.gen(function* () {
    const cp = yield* Effect.match(d.load, { onFailure: (e) => ({ ok: false as const, e }), onSuccess: (c) => ({ ok: true as const, c }) })
    if (!cp.ok) return yield* quiet(d.log(`the checkpoint could not be read (${String(cp.e)}): the Intent Agent waits until it is fixed`))
    const statements = yield* d.statements().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Statement>))
    const journeys = yield* d.journeys().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<JourneyInfo>))
    const filed = [...Object.values(cp.c.statements), ...Object.values(cp.c.journeys)].flatMap((e) => (e.state === "planned" ? (e.plans ?? []) : []))
    const gone = new Set(filed.length === 0 ? [] : yield* d.dropped(filed).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)))
    for (const x of due(statements, journeys, cp.c, statements.some((s) => s.kind === "outcome"), gone)) {
      // A topic still open about something that changed or went no longer matters: settle it.
      const prev = x.kind === "journey" ? undefined : (yield* d.load).statements[x.kind === "removed" ? x.id : x.statement.id]
      if (prev?.topic !== undefined && prev.decision === undefined) yield* quiet(d.settle(prev.topic, x.kind === "removed" ? "its statement was removed" : "its statement changed: a new round"))
      if (x.kind === "removed") {
        const { ids } = yield* d.dropServing(x.id).pipe(Effect.orElseSucceed(() => ({ ids: [] as ReadonlyArray<string> })))
        yield* setStatement(x.id, undefined)
        yield* quiet(d.log(`${x.id} was removed${ids.length > 0 ? `: dropped ${ids.join(", ")}` : ""}`))
        views.delete(x.id)
        continue
      }
      const r = x.kind === "statement" ? yield* statementRound(x.statement, journeys, prev?.decision) : yield* journeyRound(x.journey, statements)
      if (r === "outage") break
    }
    yield* quiet(d.render)
  })
  const tick = Effect.suspend(() => {
    if (queued) return Effect.void
    queued = true
    return exclusive(Effect.andThen(Effect.sync(() => void (queued = false)), pass))
  })

  /** The operator answered a topic: the statement is due again with the decision (or left as it is). */
  const answered = (key: string, answer: string | undefined, text: string | undefined) =>
    exclusive(Effect.gen(function* () {
      const [kind, id] = key.split(":") as [string, string | undefined]
      if (id === undefined) return `no topic ${key}`
      const cp = yield* d.load
      if (kind === "serve") {
        if (answer === undefined || answer === LEAVE.id) return `${id}: left as it is`
        // The journey as it is now: gone or changed since it asked, nothing is filed and its next round starts fresh.
        const j = (yield* d.journeys()).find((x) => x.id === id)
        if (j === undefined) return `${id} is gone`
        if (j.version !== cp.journeys[id]?.version) {
          yield* update((c) => {
            const journeys = { ...c.journeys }
            delete journeys[id]
            return { ...c, journeys }
          })
          return `${id} changed since it asked: its next round starts fresh`
        }
        // The answer is an outcome id: one plan linking it.
        const s = (yield* d.statements()).find((x) => x.id === answer)
        if (s === undefined) return `${answer} is not an outcome`
        const { id: plan } = yield* d.plan({ title: `${id} serves ${answer}`, journey: id, scenarios: [], changes: [{ tool: "link", params: { edge: "serves", journey: { id }, outcome: answer } }], feedback: [], steps: [`${id} delivers ${answer}: ${s.text}`], serves: `gherkin/outcome:${s.id}@${s.version}` })
        yield* setJourney(id, { version: cp.journeys[id]?.version ?? "", state: "planned", plans: [plan] })
        return `${id}: ${plan} links it to ${answer}`
      }
      const s = (yield* d.statements()).find((x) => x.id === id)
      if (s === undefined) return `${id} is gone`
      const e = cp.statements[id]
      if (e === undefined || e.version !== s.version) {
        yield* setStatement(id, undefined)
        return `${id} changed since it asked: its next round starts fresh`
      }
      if (answer === undefined || answer === LEAVE.id) return `${id}: left as it is`
      // The model reads the answer's words (its label), with the operator's reason when they gave one.
      const chosen = e.options?.find((o) => o.id === answer)?.label ?? answer
      const decision = answer === "again" ? "draft it again" : text !== undefined && text !== "" ? `${chosen}: ${text}` : chosen
      // An entry with a decision is due (checkpoint.ts): the next tick drafts it again.
      yield* setStatement(id, { ...e, state: "asked", decision })
      return `${id}: drafting again with your answer`
    }))

  return { tick, answered, rounds: () => [...views.values()] }
}
