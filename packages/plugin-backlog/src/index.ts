import { Effect, Schema, Semaphore } from "effect"
import { Agenda, Config, definePlugin, Entities, Files, PluginFailure, Surfaces, Views } from "@zarg/plugin-sdk"
import { Backlog, Drafted, FiledEntry, ItemData, Lane, Moved, OnEntry, PlanParams, Propose, Redraft, Rehearsed, Rehearsing, StageData } from "./contract"
import { current, fresh, redo, redraft, refineAgain, settle, type Stage, stageActions, STAGE_TITLES, slug, startRefine, stepperAt } from "./stages"
import { parseRef } from "@zarg/entities"
import { ENTRY_ID, type Entry, entryId, stateOf, target, upsert } from "./feedback"
import { boardCard, type Item, ITEM_ID, LANE_TITLES, LANES, moved, neighbour, nextId, pickNext } from "./items"
import { BacklogView, FeedbackView, ItemView } from "./views"

const DIR = ".zarg/feedback"
const ITEMS = ".zarg/backlog"
const TRIAGE = ".zarg/triage"
const STAGES = ["Triage", "Refine", "Re-rehearse", "Plan"] as const
const Notice = Schema.Struct({ notice: Schema.String })
const Act = Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String), text: Schema.optionalKey(Schema.String) })
const EntryData = Schema.Struct({
  ...FiledEntry.fields,
  id: Schema.String,
  count: Schema.Number,
  triage: Schema.Struct({ on: Schema.Boolean, why: Schema.String, by: Schema.Literals(["agent", "operator"]) }),
  state: Schema.optionalKey(Schema.Literals(["planned", "closed"])),
  runs: Schema.optionalKey(Schema.Array(Schema.String)),
  operatorNote: Schema.optionalKey(Schema.String),
})
const isEntry = Schema.is(EntryData)
const NO_JOURNEY = "—"
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`
const fail = (e: unknown) => new PluginFailure({ tag: "BacklogError", message: String((e as { message?: unknown })?.message ?? e) })

/** The backlog: feedback per card version (triaged in the Feedback view), later the plans built from it. */
export default definePlugin({
  name: "backlog",
  service: "Backlog",
  archetype: "service",
  implements: Backlog,
  config: Schema.Struct({}),
  scopes: { agents: true, fs: { read: [`${DIR}/**`, `${ITEMS}/**`, `${TRIAGE}/**`], write: [`${DIR}/**`, `${ITEMS}/**`, `${TRIAGE}/**`] }, entities: { read: ["gherkin/*"] } },
  views: [FeedbackView, BacklogView, ItemView],
  surfaces: [
    { kind: "nav", name: "feedback", view: "feedback", label: "Feedback" },
    { kind: "nav", name: "backlog", view: "backlog", label: "Backlog" },
    // The drawer: one plan in full over the board.
    { kind: "sheet", name: "item", view: "item" },
  ],
  entities: {
    feedback: { doc: "A tester's report on one version of an entity, and its triage.", data: EntryData, tone: "attention", glyph: "◇", open: "feedback", ops: ["get", "label", "version", "query"] },
    item: {
      doc: "A plan on the Backlog: the card changes it drafted, the feedback it closes, and its lane.",
      data: ItemData,
      tone: "accent",
      glyph: "▦",
      open: "backlog",
      ops: ["get", "label", "version", "query"],
      commands: { move: "move-item", park: "park-item", accept: "accept-item", drop: "drop-item" },
    },
  },
  methods: {
    file: { doc: "File feedback (the same report on the same version again counts it).", params: Schema.Struct({ entries: Schema.Array(FiledEntry) }), success: Schema.Struct({ ids: Schema.Array(Schema.String) }) },
    status: { doc: "Where feedback stands.", params: Schema.Struct({ ids: Schema.Array(Schema.String) }), success: Schema.Array(Schema.Struct({ id: Schema.String, state: Schema.Literals(["open", "stale", "planned", "closed"]), on: Schema.Boolean })) },
    act: { doc: "The Feedback view: open it, show a journey, flip an entry.", params: Act, success: Notice },
    plan: { doc: "Add a plan (it lands in Ready; its feedback is planned).", params: PlanParams, success: Schema.Struct({ id: Schema.String }) },
    next: { doc: "The next plan for the Planner: the oldest Ready one it can take.", params: Schema.Struct({}), success: Schema.NullOr(ItemData) },
    moved: { doc: "Record a move by an agent (the Planner, reconcile).", params: Moved, success: Schema.Null },
    "move-item": { doc: "Move a plan to a lane.", params: Schema.Struct({ id: Schema.String, to: Lane }), success: Notice },
    "park-item": { doc: "Park a plan in Backlog.", params: Schema.Struct({ id: Schema.String }), success: Notice },
    "accept-item": { doc: "Accept a plan as done.", params: Schema.Struct({ id: Schema.String }), success: Notice },
    "drop-item": { doc: "Drop a plan (its feedback is open again).", params: Schema.Struct({ id: Schema.String }), success: Notice },
    stages: { doc: "Every journey's triage stage (the Triage Agent's work list).", params: Schema.Struct({}), success: Schema.Array(StageData) },
    feedbackOf: { doc: "A journey's open feedback (on and off).", params: Schema.Struct({ journey: Schema.String }), success: Schema.Array(OnEntry) },
    redraft: { doc: "The accepted draft fails as a whole: back to Refine with the problems.", params: Redraft, success: Schema.Null },
    redo: { doc: "Draft one card of a journey's round again (the Triage Agent's view, d).", params: Schema.Struct({ journey: Schema.String, card: Schema.String }), success: Notice },
    propose: { doc: "The Triage Agent's proposal for a card.", params: Propose, success: Schema.Null },
    rehearsing: { doc: "The Triage Agent started (or waits for) a re-rehearse.", params: Rehearsing, success: Schema.Null },
    rehearsed: { doc: "A re-rehearse's results: on to Plan, or back to Refine with fresh feedback.", params: Rehearsed, success: Schema.Null },
    drafted: { doc: "The Triage Agent's drafted plan.", params: Drafted, success: Schema.Null },
    agenda: { doc: "Feedback files the backlog could not read, and plans that need the operator.", params: Schema.Struct({}), success: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, detail: Schema.String, about: Schema.Array(Schema.String), priority: Schema.Number })) },
  },
  make: Effect.gen(function* () {
    const files = yield* Files
    const views = yield* Views
    const surfaces = yield* Surfaces
    // A plan that becomes Ready says so: the core's Planner wakes on it.
    const ready = Effect.ignore((yield* Agenda).changed)
    const entities = yield* Entities
    yield* Config
    // Files that are not entries (a hand edit, a merge, another format): skipped, and named on the agenda.
    let bad: ReadonlyArray<string> = []
    // ponytail: every call reads the folder; an index file when there are thousands of entries.
    const load = Effect.gen(function* () {
      const names = (yield* files.list(DIR).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))).filter((n) => n.endsWith(".json"))
      const read = yield* Effect.forEach(names, (n) =>
        files.read(`${DIR}/${n}`).pipe(
          Effect.map((t) => { try { return JSON.parse(t) as unknown } catch { return undefined } }),
          Effect.orElseSucceed(() => undefined),
          Effect.map((v) => ({ n, v })),
        ))
      // An entry is its own file: its id is its name, so a copy under another name is not a second entry.
      const ok = (x: { n: string; v: unknown }) => isEntry(x.v) && ENTRY_ID.test(x.v.id) && x.n === `${x.v.id}.json`
      bad = read.filter((x) => !ok(x)).map((x) => x.n)
      return read.filter(ok).map((x) => x.v as Entry)
    })
    // One writer at a time: filing and flipping read, change and write the same files.
    const writing = yield* Semaphore.make(1)
    const save = (e: Entry) => files.write(`${DIR}/${e.id}.json`, `${JSON.stringify(e, null, 2)}\n`)
    /** Each entry with its state now: open, or stale once its entity changed (or went). */
    const withStates = (es: ReadonlyArray<Entry>) =>
      Effect.gen(function* () {
        // One lookup for every distinct entity (many entries share a card), not a round trip per entry.
        const refs = [...new Set(es.filter((e) => e.state === undefined).map((e) => e.ref))]
        const now = refs.length === 0 ? [] : (yield* entities.many(refs).pipe(Effect.orElseSucceed(() => ({ entities: [], failed: [] })))).entities
        const current = new Set(now.map((x) => x.ref))
        return es.map((e) => ({ e, state: e.state ?? stateOf(e, !current.has(e.ref)) }))
      })

    // Each journey's stage: one file each under .zarg/triage (a file that is not a stage is skipped).
    const isStage = Schema.is(StageData)
    const loadStages = Effect.gen(function* () {
      const names = (yield* files.list(TRIAGE).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))).filter((n) => n.endsWith(".json"))
      const read = yield* Effect.forEach(names, (n) =>
        files.read(`${TRIAGE}/${n}`).pipe(Effect.map((t) => { try { return JSON.parse(t) as unknown } catch { return undefined } }), Effect.orElseSucceed(() => undefined)))
      return read.filter(isStage) as ReadonlyArray<Stage>
    })
    const stageOf = (j: string) => Effect.map(loadStages, (all) => all.find((x) => x.journey === j) ?? fresh(j))
    const saveStage = (st: Stage) => files.write(`${TRIAGE}/${slug(st.journey)}.json`, `${JSON.stringify(st, null, 2)}\n`)
    /** Change a journey's stage (one writer at a time); the Triage Agent wakes when its part comes. */
    const updateStage = (j: string, f: (st: Stage) => Stage | string, wake = false) =>
      Effect.gen(function* () {
        const next = f(yield* stageOf(j))
        if (typeof next === "string") return next
        yield* saveStage(next)
        if (wake) yield* ready
        return undefined
      }).pipe(writing.withPermits(1))
    /** A journey's open feedback, on and off. */
    const openIn = (j: string) =>
      Effect.gen(function* () {
        const all = yield* withStates(yield* load)
        return all.filter((x) => x.state === "open" && (x.e.journeys.includes(j) || (j === NO_JOURNEY && x.e.journeys.length === 0))).map((x) => x.e)
      })
    /** A journey's open feedback that is on (what Refine works from). */
    const onEntries = (j: string) => Effect.map(openIn(j), (es) => es.filter((e) => e.triage.on))
    const call = (c: { readonly tool: string; readonly params: unknown }) => `- gherkin/${c.tool} ${JSON.stringify(c.params)}`
    /** What the selected journey's stage asks for now. */
    const workOf = (st: Stage, on: number) => {
      const leftOut = st.proposals.filter((p) => p.status === "skipped" && (p.problems ?? []).length > 0)
      const leftLines = leftOut.length > 0 ? ["", `Left out: ${leftOut.map((p) => `${p.card} (${p.problems!.join("; ")})`).join(", ")}`] : []
      const noteLine = st.note !== undefined ? ["", st.note] : []
      if (st.stage === "triage") return on === 0 ? "Turn feedback on (space) to refine it; **n** adds your note." : `**r** Refine the ${plural(on, "entry")} that are on: the Triage Agent drafts card changes, then re-rehearses the journey on them.`
      if (st.stage === "refine") {
        const p = current(st)
        const done = st.proposals.filter((x) => x.status === "accepted" || x.status === "skipped").length
        return [p === undefined ? "Every card drafted." : `The Triage Agent is drafting ${p.card} (${done + 1} of ${st.proposals.length}). Its history (in the rail) shows each card as it goes; the re-rehearse starts when the last is drafted.`, ...noteLine, ...leftLines].join("\n")
      }
      if (st.stage === "rehearse") return [`Re-rehearsing ${st.journey} on the drafted cards${st.run !== undefined ? ` (run ${st.run})` : ""}: ${plural(st.draft.length, "change")}.`, ...noteLine, "", "**r** Refine again"].join("\n")
      if (st.stage === "plan") {
        const r = st.results
        const accepted = st.proposals.filter((p) => p.status === "accepted")
        return [
          ...(r !== undefined ? [`Re-rehearsed: ${plural(r.resolved.length, "entry")} resolved${r.fresh.length > 0 ? `; new: ${r.fresh.map((f) => `${f.card} ${f.kind}`).join(", ")}` : ""}.`, ""] : []),
          ...(st.plan !== undefined ? [`**${st.plan.title}**`, "", ...st.plan.steps.map((x, k) => `${k + 1}. ${x}`)] : [st.draft.length > 0 ? "The Triage Agent is drafting the plan." : "Nothing drafted to plan."]),
          ...(accepted.length > 0 ? ["", ...accepted.flatMap((p) => [`${p.card}: ${p.summary}`, ...p.changes.map(call)])] : []),
          ...leftLines,
          ...noteLine,
          "",
          st.plan !== undefined ? "**a** Accept (to the Backlog) · **r** Refine again" : "**r** Refine again",
        ].join("\n")
      }
      return `Backlogged as ${st.item ?? "a plan"}. **r** starts a new round.`
    }
    let journey: string | undefined
    // ponytail: grows by one per card version that had feedback shown; clear it when that gets large.
    const contextOf = new Map<string, string>()
    const refresh = Effect.gen(function* () {
      const all = yield* withStates(yield* load)
      const open = all.filter((x) => x.state === "open").map((x) => x.e)
      const byJourney = new Map<string, Array<Entry>>()
      for (const e of open) for (const j of e.journeys.length > 0 ? e.journeys : [NO_JOURNEY]) byJourney.set(j, [...(byJourney.get(j) ?? []), e])
      const stages = yield* loadStages
      const staged = (j: string) => stages.find((x) => x.journey === j) ?? fresh(j)
      // Journeys with open feedback, and those a stage is still working on.
      const names = [...new Set([...byJourney.keys(), ...stages.filter((x) => x.stage !== "triage" && x.stage !== "planned").map((x) => x.journey)])].sort((a, b) => (a === NO_JOURNEY ? 1 : b === NO_JOURNEY ? -1 : a.localeCompare(b)))
      if (journey === undefined || !names.includes(journey)) journey = names[0]
      const st = journey === undefined ? undefined : staged(journey)
      const all_ = journey === undefined ? [] : (byJourney.get(journey) ?? [])
      // Past Triage, the list is what the round works on; at Plan, what the re-rehearse did not resolve.
      const working = st !== undefined && st.stage !== "triage" && st.stage !== "planned" && st.inputs !== undefined
      const shown = working ? all_.filter((e) => st!.inputs!.includes(e.id) && !(st!.stage === "plan" && (st!.results?.resolved ?? []).includes(e.id))) : all_
      const on = shown.filter((e) => e.triage.on).length
      const at = st === undefined ? 0 : Math.min(3, stepperAt(st))
      const stepper = STAGES.map((s, i) => (i < at || st?.stage === "planned" ? `✓ ${s}` : i === at ? `**● ${s}**` : `○ ${s}`)).join("  ───  ")
      yield* views.set("feedback", FeedbackView, "stage", {
        markdown: journey === undefined ? `${stepper}\n\nNo open feedback. Testers file it when they rehearse.` : `${stepper}\n\n**${journey}** · ${plural(shown.length, "entry")} · ${on} on`,
      })
      yield* views.set("feedback", FeedbackView, "journeys", { rows: names.map((j) => ({ id: j, cells: { journey: j, open: String(byJourney.get(j)?.length ?? 0), stage: STAGE_TITLES[staged(j).stage] } })) })
      yield* views.set("feedback", FeedbackView, "work", { markdown: st === undefined ? "" : workOf(st, on) })
      const sev = { high: 0, medium: 1, low: 2 } as const
      const sorted = [...shown].sort((a, b) => sev[a.severity] - sev[b.severity] || a.id.localeCompare(b.id))
      yield* views.set("feedback", FeedbackView, "feedback", {
        actions: st === undefined ? ["note"] : [...stageActions(st), "note"],
        rows: sorted.map((e) => ({
          id: e.id,
          on: e.triage.on,
          ...(e.operatorNote !== undefined ? { text: e.operatorNote } : {}),
          cells: { card: target(e.ref), severity: e.severity, kind: e.kind, note: e.operatorNote !== undefined ? "✎" : "" },
          search: [e.id, e.ref, e.persona, e.kind, e.severity, e.note, ...e.journeys].join(" "),
        })),
      })
      // Shown entries are open: their ref is the card as it is now, so its context is fixed for that ref.
      yield* Effect.forEach([...new Set(sorted.map((e) => e.ref))].filter((r) => !contextOf.has(r)), (r) =>
        Effect.map(entities.context(target(r)).pipe(Effect.orElseSucceed(() => "")), (c) => { contextOf.set(r, c) }), { concurrency: 8, discard: true })
      const contexts = sorted.map((e) => [e.id, contextOf.get(e.ref) ?? ""] as const)
      const detail = (e: Entry, context: string) =>
        [
          `**${e.kind} · ${e.severity}** · ${e.triage.on ? "on" : "off"} (${e.triage.by === "operator" ? "your call" : "the agent's call"}: ${e.triage.why})`,
          "",
          e.note,
          ...(e.operatorNote !== undefined ? ["", `**Your note:** ${e.operatorNote}`] : []),
          "",
          `by ${e.persona} · in ${e.journeys.join(", ") || NO_JOURNEY} · from ${e.from.agent} ${e.from.run}${e.count > 1 ? ` · reported ${e.count} times` : ""}`,
          ...(context.length > 0 ? ["", "```gherkin", context.trim(), "```"] : []),
        ].join("\n")
      yield* views.set("feedback", FeedbackView, "detail", { markdown: "", rows: Object.fromEntries(contexts.map(([id, c]) => [id, detail(sorted.find((e) => e.id === id)!, c)])) })
      return { journeys: names.length, open: open.length }
    })

    // Plans: one file each; a file that is not a plan is skipped (and named on the agenda).
    let badItems: ReadonlyArray<string> = []
    const isItem = Schema.is(ItemData)
    const loadItems = Effect.gen(function* () {
      const names = (yield* files.list(ITEMS).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))).filter((n) => n.endsWith(".json"))
      const read = yield* Effect.forEach(names, (n) =>
        files.read(`${ITEMS}/${n}`).pipe(
          Effect.map((t) => { try { return JSON.parse(t) as unknown } catch { return undefined } }),
          Effect.orElseSucceed(() => undefined),
          Effect.map((v) => ({ n, v })),
        ))
      const ok = (x: { n: string; v: unknown }) => isItem(x.v) && ITEM_ID.test(x.v.id) && x.n === `${x.v.id}.json`
      badItems = read.filter((x) => !ok(x)).map((x) => x.n)
      return read.filter(ok).map((x) => x.v as Item)
    })
    const saveItem = (i: Item) => files.write(`${ITEMS}/${i.id}.json`, `${JSON.stringify(i, null, 2)}\n`)
    /** Feedback a plan took (or gave back): planned, closed, or open again. */
    const markFeedback = (ids: ReadonlyArray<string>, state: "planned" | "closed" | undefined) =>
      Effect.gen(function* () {
        for (const e of (yield* load).filter((x) => ids.includes(x.id))) {
          const { state: _, ...rest } = e
          yield* save(state === undefined ? rest : { ...rest, state })
        }
      })
    const changedRefs = (items: ReadonlyArray<Item>) =>
      Effect.map(
        // Only refs with the version the plan was drafted on (cards an apply added carry none: nothing to go stale).
        Effect.forEach([...new Set(items.filter((i) => i.status === "backlog" || i.status === "ready").flatMap((i) => i.cards.map((c) => c.ref)).filter((ref) => parseRef(ref)?.version !== undefined))], (ref) =>
          Effect.map(entities.changed(ref).pipe(Effect.orElseSucceed(() => false)), (c) => (c ? [ref] : [])), { concurrency: 8 }),
        (xs) => new Set(xs.flat()),
      )
    const refreshBoard = Effect.gen(function* () {
      const items = (yield* loadItems).filter((i) => i.dropped !== true)
      const changed = yield* changedRefs(items)
      const byId = (a: Item, b: Item) => (Number(a.id.slice(2)) || 0) - (Number(b.id.slice(2)) || 0)
      yield* views.set("backlog", BacklogView, "board", {
        lanes: LANES.map((lane) => ({ id: lane, title: LANE_TITLES[lane], cards: items.filter((i) => i.status === lane).sort(lane === "done" ? (a, b) => byId(b, a) : byId).map((i) => boardCard(i, items, changed)) })),
      })
      return items
    })
    let selected: string | undefined
    const itemMarkdown = (i: Item, feedback: ReadonlyArray<Entry>) =>
      [
        `**${i.title}**`,
        "",
        `${i.id} · ${LANE_TITLES[i.status]}${i.agent !== undefined ? ` · ${i.agent}` : ""} · ${i.journey}${i.persona !== undefined ? ` · ${i.persona}` : ""}${i.severity !== undefined ? ` · ${i.severity}` : ""}`,
        ...(i.needs !== undefined ? ["", `**Needs you:** ${i.needs}`] : []),
        "",
        `**Cards** ${i.cards.map((c) => `\`${target(c.ref).split(":")[1] ?? c.ref}\``).join(" ")}`,
        ...(i.steps.length > 0 ? ["", "**Steps**", ...i.steps.map((st, k) => `${k + 1}. ${st}`)] : []),
        ...(feedback.length > 0 ? ["", `**Feedback ${feedback.length}**`, ...feedback.map((f) => `- ${f.kind} (${f.severity}): ${f.note}`)] : []),
        ...(i.changes.length > 0 ? ["", `**Changes ${i.changes.length}**`, ...i.changes.map((c) => `- gherkin/${c.tool} ${JSON.stringify(c.params)}`)] : []),
        ...((i.after ?? []).length > 0 ? ["", `**After** ${i.after!.join(", ")}`] : []),
        ...(i.events.length > 0 ? ["", "**Events**", ...i.events.map((e) => `- ${e.what} (${e.by})`)] : []),
      ].join("\n")
    const showItem = (id: string) =>
      Effect.gen(function* () {
        const i = (yield* loadItems).find((x) => x.id === id)
        if (i === undefined) return false
        const feedback = (yield* load).filter((e) => i.feedback.includes(e.id))
        yield* views.set("backlog", ItemView, "item", { markdown: itemMarkdown(i, feedback) })
        return true
      })
    /** Move a plan by hand or by an agent: the move recorded; Done closes its feedback. */
    const move = (id: string, to: Item["status"], by: string, what?: string, needs?: string, cards?: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const i = (yield* loadItems).find((x) => x.id === id)
        if (i === undefined) return `no plan ${id}`
        // The operator's move to the lane a plan is in does nothing, unless it clears what the plan needed of them; an agent's note is kept.
        if (i.status === to && needs === undefined && i.needs === undefined && by === "operator") return `${id} is already in ${LANE_TITLES[to]}`
        const next = moved(i, to, by, what)
        // The cards an apply affected join the plan's (a new card, a reworded state's cards): a landed pass covers them.
        const known = new Set(next.cards.map((c) => target(c.ref)))
        const withCards = cards === undefined ? next : { ...next, cards: [...next.cards, ...cards.filter((c) => !known.has(`gherkin/card:${c}`)).map((c) => ({ ref: `gherkin/card:${c}` }))] }
        yield* saveItem(needs !== undefined ? { ...withCards, needs } : withCards)
        if (to === "done") yield* markFeedback(i.feedback, "closed")
        return `${id} → ${LANE_TITLES[to]}`
      }).pipe(writing.withPermits(1), Effect.tap(() => (to === "ready" ? ready : Effect.void)))
    const drop = (id: string) =>
      Effect.gen(function* () {
        const i = (yield* loadItems).find((x) => x.id === id)
        if (i === undefined) return `no plan ${id}`
        yield* saveItem({ ...i, dropped: true, events: [...i.events, { what: "dropped", by: "operator" }] })
        yield* markFeedback(i.feedback, undefined)
        return `${id} dropped; its feedback is open again`
      }).pipe(writing.withPermits(1))
    const plan = (p: PlanParams) =>
      Effect.gen(function* () {
        const id = nextId(yield* loadItems)
        yield* saveItem({ ...p, id, status: "ready", events: [{ what: "planned", by: "Triage Agent" }] })
        yield* markFeedback(p.feedback, "planned")
        return { id }
      }).pipe(writing.withPermits(1), Effect.tap(() => ready), Effect.mapError(fail))
    const next = () =>
      Effect.gen(function* () {
        const items = (yield* loadItems).filter((i) => i.dropped !== true)
        const changed = yield* changedRefs(items)
        return pickNext(items, (ref) => changed.has(ref)) ?? null
      }).pipe(Effect.mapError(fail))

    /** Each entry filed, or "" where it was refused (a ref without a version) or could not be saved; the rest are filed. */
    const file = ({ entries }: { entries: ReadonlyArray<FiledEntry> }) =>
      Effect.gen(function* () {
        const had = new Map((yield* load).map((e) => [e.id, e]))
        const ids: Array<string> = []
        for (const f of entries) {
          if (parseRef(f.ref)?.version === undefined) {
            ids.push("")
            continue
          }
          const e = upsert(had.get(entryId(f)), f)
          const saved = yield* Effect.match(save(e), { onFailure: () => false, onSuccess: () => true })
          if (saved) had.set(e.id, e)
          ids.push(saved ? e.id : "")
        }
        return { ids }
      }).pipe(writing.withPermits(1), Effect.mapError(fail))
    const status = ({ ids }: { ids: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        const all = yield* withStates((yield* load).filter((e) => ids.includes(e.id)))
        return all.map((x) => ({ id: x.e.id, state: x.state, on: x.e.triage.on }))
      })
    const boardAct = (action: string, rows: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (action === "item" && rows[0] !== undefined) {
          selected = rows[0]
          if (!(yield* showItem(rows[0]))) return `no plan ${rows[0]}`
          yield* surfaces.open({ surface: "item", agent: "backlog", focus: true })
          return rows[0]
        }
        if ((action === "move-left" || action === "move-right") && rows[0] !== undefined) {
          const i = (yield* loadItems).find((x) => x.id === rows[0])
          return i === undefined ? `no plan ${rows[0]}` : yield* move(i.id, neighbour(i.status, action === "move-right" ? 1 : -1), "operator")
        }
        // The drawer's buttons act on the plan it shows.
        if (selected !== undefined && ["ready", "park", "done", "drop"].includes(action)) {
          const notice = action === "drop" ? yield* drop(selected) : yield* move(selected, action === "ready" ? "ready" : action === "park" ? "backlog" : "done", "operator")
          yield* showItem(selected)
          return notice
        }
        return action === "open" ? "Backlog" : `nothing to ${action}`
      })
    // One Backlog plan at a time: a double press never backlogs the stage twice.
    const planning = yield* Semaphore.make(1)
    const stageAct = (j: string, action: string) =>
      Effect.gen(function* () {
        if (action === "refine") {
          const entries = yield* openIn(j)
          const st0 = yield* stageOf(j)
          // From Plan, or out of a re-rehearse that hangs: again, over the draft so far.
          if (st0.stage === "plan" || st0.stage === "rehearse") {
            const refused = yield* updateStage(j, (st) => refineAgain(st, entries), true)
            if (refused !== undefined) return refused
            return `${j}: refining ${plural((yield* stageOf(j)).proposals.filter((p) => p.status === "waiting").length, "card")} again`
          }
          const refused = yield* updateStage(j, (st) => (st.stage === "triage" || st.stage === "planned" ? startRefine(st, entries) : `${j} is being refined already`), true)
          return refused ?? `${j}: refining ${plural(new Set(entries.filter((e) => e.triage.on).map((e) => target(e.ref))).size, "card")}`
        }
        if (action !== "accept") return `nothing to ${action}`
        // Accept: the plan to the Backlog, with the draft, the cards it changes (at their versions now), the feedback it answers.
        return yield* Effect.gen(function* () {
          const st = yield* stageOf(j)
          if (st.stage !== "plan" || st.plan === undefined) return `${j} has no plan to accept yet`
          if (st.draft.length === 0) {
            yield* updateStage(j, (x) => ({ ...fresh(x.journey), ...(x.dismissed !== undefined ? { dismissed: x.dismissed } : {}) }))
            return `nothing to backlog in ${j}: every change was left out`
          }
          const entries = yield* openIn(j)
          const accepted = st.proposals.filter((p) => p.status === "accepted")
          // What the plan answers: the entries it started from that an accepted proposal answers, or that are on its cards.
          const answers = (e: Entry) => accepted.some((p) => p.answers.includes(e.id) || p.card === (parseRef(e.ref)?.id ?? ""))
          const inputs = entries.filter((e) => (st.inputs ?? entries.filter((x) => x.triage.on).map((x) => x.id)).includes(e.id))
          const closes = inputs.filter(answers)
          const cards = yield* Effect.forEach((st.cards ?? []).filter((c) => /^UX-/.test(c)), (c) => Effect.map(entities.version(`gherkin/card:${c}`).pipe(Effect.orElseSucceed(() => null)), (v) => (v === null ? [] : [{ ref: `gherkin/card:${c}@${v}` }])))
          const worst = closes.map((e) => e.severity).sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b))[0]
          const { id } = yield* plan({ title: st.plan.title, journey: j, cards: cards.flat(), changes: st.draft, feedback: closes.map((e) => e.id), steps: st.plan.steps, ...(closes[0] !== undefined ? { persona: closes[0].persona } : {}), ...(worst !== undefined ? { severity: worst } : {}) })
          yield* updateStage(j, (x) => ({ ...x, stage: "planned", item: id }))
          return `${j}: backlogged as ${id}`
        }).pipe(planning.withPermits(1))
      })
    const act = ({ agent, action, rows, text }: { agent: string; action: string; rows: ReadonlyArray<string>; text?: string }) =>
      Effect.gen(function* () {
        if (agent === "backlog") {
          const notice = yield* boardAct(action, rows)
          yield* refreshBoard
          return { notice }
        }
        if (agent !== "feedback") return { notice: `backlog has no view ${agent}` }
        if (action === "journey" && rows[0] !== undefined) journey = rows[0]
        // The view opens with its cursor on the first journey: show that one.
        if (action === "open") journey = undefined
        // The operator's note on an entry, for refinement: blank clears it.
        if (action === "note") {
          const saved = yield* Effect.gen(function* () {
            const e = (yield* load).find((x) => x.id === rows[0])
            if (e === undefined) return false
            const { operatorNote: _, ...rest } = e
            const t = (text ?? "").trim()
            yield* save(t.length > 0 ? { ...rest, operatorNote: t } : rest)
            return t.length > 0
          }).pipe(writing.withPermits(1))
          yield* refresh
          return { notice: saved ? "note saved" : "note cleared" }
        }
        if (["refine", "accept"].includes(action)) {
          if (journey === undefined) yield* refresh
          const notice = journey === undefined ? "no journey with feedback" : yield* stageAct(journey, action)
          yield* refresh
          return { notice }
        }
        if (action === "toggle")
          yield* Effect.gen(function* () {
            const all = yield* load
            for (const id of rows) {
              const e = all.find((x) => x.id === id)
              if (e !== undefined) yield* save({ ...e, triage: { on: !e.triage.on, why: e.triage.why, by: "operator" } })
            }
          }).pipe(writing.withPermits(1))
        const r = yield* refresh
        return { notice: action === "toggle" ? `${plural(rows.length, "entry")} flipped` : r.open === 0 ? "no open feedback" : `${plural(r.open, "open entry")} in ${plural(r.journeys, "journey")}` }
      }).pipe(Effect.mapError(fail))

    const byIds = (ids: ReadonlyArray<string>) => Effect.map(load, (all) => all.filter((e) => ids.includes(e.id)).map((e) => ({ id: e.id, data: e })))
    const agenda = () =>
      Effect.gen(function* () {
        yield* load
        const items = yield* loadItems
        return [
          ...bad.map((n) => ({ id: `backlog:bad-file:${n}`, title: `Feedback file ${DIR}/${n} is not a feedback entry`, detail: "The backlog skips it. Fix or remove the file (an entry's id is its file name).", about: [], priority: 2 })),
          ...badItems.map((n) => ({ id: `backlog:bad-file:${n}`, title: `Backlog file ${ITEMS}/${n} is not a plan`, detail: "The backlog skips it. Fix or remove the file (a plan's id is its file name).", about: [], priority: 2 })),
          ...items.filter((i) => i.needs !== undefined && i.dropped !== true).map((i) => ({ id: `backlog:needs:${i.id}`, title: `${i.id} ${i.title} needs you`, detail: i.needs!, about: i.cards.map((c) => target(c.ref).split(":")[1] ?? c.ref), priority: 1 })),
        ]
      })
    const cmd = (f: Effect.Effect<string, unknown>) => Effect.andThen(f, (notice) => Effect.as(refreshBoard, { notice })).pipe(Effect.mapError(fail))
    const nul = <E>(e: Effect.Effect<unknown, E>) => Effect.as(e, null).pipe(Effect.mapError(fail))
    // The agent's moves on a stage: the Feedback view follows them without a key press.
    const moved_ = <E>(e: Effect.Effect<unknown, E>) => nul(Effect.andThen(e, Effect.ignore(refresh)))
    return {
      file,
      status,
      act,
      agenda,
      stages: () => loadStages.pipe(Effect.mapError(fail)),
      feedbackOf: ({ journey: j }: { journey: string }) => Effect.map(openIn(j), (es) => es.map((e) => ({ id: e.id, ref: e.ref, kind: e.kind, severity: e.severity, note: e.note, persona: e.persona, on: e.triage.on, ...(e.operatorNote !== undefined ? { operatorNote: e.operatorNote } : {}) }))).pipe(Effect.mapError(fail)),
      redraft: (p: typeof Redraft.Type) => moved_(updateStage(p.journey, (st) => (st.stage === "rehearse" ? redraft(st, p.problems) : st), true)),
      redo: (p: { journey: string; card: string }) =>
        Effect.gen(function* () {
          const refused = yield* updateStage(p.journey, (st) => redo(st, p.card), true)
          yield* Effect.ignore(refresh)
          return { notice: refused ?? `${p.journey}: drafting ${p.card} again` }
        }).pipe(Effect.mapError(fail)),
      // Into the draft as it comes (or left out with its problems); the last one moves on, and the agent wakes for it.
      propose: (p: typeof Propose.Type) => moved_(updateStage(p.journey, (st) => settle(st, p), true)),
      rehearsing: (p: typeof Rehearsing.Type) =>
        moved_(
          updateStage(p.journey, (st) => {
            // `clear`: the run is gone (stopped); the next wake starts another.
            const { run: _r, ...rest } = st
            return { ...(p.clear === true ? rest : st), ...(p.run !== undefined ? { run: p.run } : {}), ...(p.cards !== undefined ? { cards: p.cards } : {}), ...(p.note !== undefined ? { note: p.note } : {}) }
          }),
        ),
      rehearsed: (p: typeof Rehearsed.Type) =>
        moved_(
          updateStage(p.journey, (st) => {
            const { run: _r, note: _n, ...rest } = st
            const results = { resolved: p.resolved, fresh: p.fresh }
            // On to Plan, where new findings are shown (a later rehearse files them as feedback).
            if (st.stage !== "rehearse") return st
            return { ...rest, stage: "plan" as const, results, ...(p.cards !== undefined ? { cards: p.cards } : {}) }
          }, true),
        ),
      drafted: (p: typeof Drafted.Type) => moved_(updateStage(p.journey, (st) => ({ ...st, plan: { title: p.title, steps: p.steps } }))),
      plan,
      next,
      moved: ({ id, to, by, what, needs, cards }: { id: string; to: Item["status"]; by: string; what?: string; needs?: string; cards?: ReadonlyArray<string> }) => Effect.as(move(id, to, by, what, needs, cards), null).pipe(Effect.mapError(fail)),
      "move-item": ({ id, to }: { id: string; to: Item["status"] }) => cmd(move(id, to, "operator")),
      "park-item": ({ id }: { id: string }) => cmd(move(id, "backlog", "operator")),
      "accept-item": ({ id }: { id: string }) => cmd(move(id, "done", "operator")),
      "drop-item": ({ id }: { id: string }) => cmd(drop(id)),
      entities: {
        feedback: {
          get: byIds,
          query: ({ where }: { where?: Readonly<Record<string, unknown>> }) =>
            Effect.map(load, (all) => all.filter((e) => where === undefined || Object.entries(where).every(([k, v]) => JSON.stringify((e as Record<string, unknown>)[k]) === JSON.stringify(v))).map((e) => e.id)),
          label: (x: { id: string; data: Entry }) => `${x.data.kind} on ${target(x.data.ref).split(":")[1] ?? x.data.ref}: ${x.data.note.slice(0, 60)}`,
        },
        item: {
          get: (ids: ReadonlyArray<string>) => Effect.map(loadItems, (all) => all.filter((i) => ids.includes(i.id)).map((i) => ({ id: i.id, data: i }))),
          query: ({ where }: { where?: Readonly<Record<string, unknown>> }) =>
            Effect.map(loadItems, (all) => all.filter((i) => where === undefined || Object.entries(where).every(([k, v]) => JSON.stringify((i as unknown as Record<string, unknown>)[k]) === JSON.stringify(v))).map((i) => i.id)),
          label: (x: { id: string; data: Item }) => `${x.id} ${x.data.title}`,
        },
      },
    }
  }),
})
