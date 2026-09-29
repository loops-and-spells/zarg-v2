import { Effect, Schema, Semaphore } from "effect"
import { Agenda, Config, definePlugin, Entities, Files, PluginFailure, Surfaces, Views } from "@zarg/plugin-sdk"
import { Gherkin } from "@zarg/plugin-gherkin/contract"
import { Backlog, Drafted, PlansParams, FiledEntry, ItemData, Lane, Moved, OnEntry, PlanParams, Propose, Redraft, Rehearsed, Rehearsing, StageData } from "./contract"
import { current, fresh, inTriage, nextQueued, redo, redraft, refineAgain, settle, type Stage, stageActions, stageLabel, slug, startRefine } from "./stages"
import { parseRef } from "@zarg/entities"
import { ENTRY_ID, type Entry, entryId, stateOf, target, upsert } from "./feedback"
import { boardCard, type Item, ITEM_ID, LANE_TITLES, LANES, moved, neighbour, nextId, pickNext, stale } from "./items"
import { BacklogView, FeedbackView, ItemView } from "./views"
import { planText } from "./plan-text"

const DIR = ".zarg/feedback"
const ITEMS = ".zarg/backlog"
const TRIAGE = ".zarg/triage"
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
  notReportedIn: Schema.optionalKey(Schema.String),
})
const isEntry = Schema.is(EntryData)
const NO_JOURNEY = "—"
const plural = (n: number, s: string) => `${n} ${n === 1 ? s : s.endsWith("y") ? `${s.slice(0, -1)}ies` : `${s}s`}`
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
  // Resync dry-runs a plan's changes on the graph as it is now.
  pluginDependencies: [Gherkin],
  surfaces: [
    { kind: "nav", name: "feedback", view: "feedback", label: "Feedback" },
    { kind: "nav", name: "backlog", view: "backlog", label: "Backlog" },
    // The drawer: one plan in full, over the right of the board while the Backlog is open (the board keeps its width).
    { kind: "panel", name: "item", view: "item", scope: "agent", edge: "right", size: 90, input: "onFocus", overlay: true },
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
    file: { doc: "File feedback (the same report on the same version again counts it); with the cards a run walked, their feedback it no longer reports closes.", params: Schema.Struct({ entries: Schema.Array(FiledEntry), walked: Schema.optionalKey(Schema.Array(Schema.String)), run: Schema.optionalKey(Schema.String) }), success: Schema.Struct({ ids: Schema.Array(Schema.String) }) },
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
    walking: { doc: "The journeys a rehearse run walks now (none: it ended): their feedback is locked meanwhile.", params: Schema.Struct({ run: Schema.String, journeys: Schema.Array(Schema.String) }), success: Schema.Null },
    assign: { doc: "The triage worker that took a journey (none: back in line).", params: Schema.Struct({ journey: Schema.String, worker: Schema.optionalKey(Schema.String) }), success: Schema.Null },
    redo: { doc: "Draft one card of a journey's round again (the Triage Agent's view, d).", params: Schema.Struct({ journey: Schema.String, card: Schema.String }), success: Notice },
    propose: { doc: "The Triage Agent's proposal for a card.", params: Propose, success: Schema.Null },
    rehearsing: { doc: "The Triage Agent started (or waits for) a re-rehearse.", params: Rehearsing, success: Schema.Null },
    rehearsed: { doc: "A re-rehearse's results: on to Plan, or back to Refine with fresh feedback.", params: Rehearsed, success: Schema.Null },
    drafted: { doc: "The Triage Agent's drafted plan.", params: Drafted, success: Schema.Null },
    plans: { doc: "A folded triage round's plans, in order, to the Backlog lane: each waits on the plans it names by index; the journey is planned until the last is dropped.", params: PlansParams, success: Schema.Struct({ ids: Schema.Array(Schema.String) }) },
    agenda: { doc: "Feedback files the backlog could not read, and plans that need the operator.", params: Schema.Struct({}), success: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, detail: Schema.String, about: Schema.Array(Schema.String), priority: Schema.Number })) },
  },
  make: Effect.gen(function* () {
    const files = yield* Files
    const views = yield* Views
    const surfaces = yield* Surfaces
    // A plan that becomes Ready says so: the core's Planner wakes on it.
    const ready = Effect.ignore((yield* Agenda).changed)
    const entities = yield* Entities
    const gherkin = yield* Gherkin
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
      if (st.stage === "triage") return [on === 0 ? "Turn feedback on (space) to refine it; **n** adds your note." : `**r** Refine the ${plural(on, "entry")} that are on: a triage worker drafts the card changes, then the plan goes to the Backlog.`, ...noteLine].join("\n")
      if (st.stage === "refine") {
        const p = current(st)
        const done = st.proposals.filter((x) => x.status === "accepted" || x.status === "skipped").length
        if (st.worker === undefined) return [`Queued for triage: ${plural(st.proposals.length, "card")}. A triage worker takes it when one is free; its feedback is read-only until its plan is on the Backlog.`, ...noteLine].join("\n")
        return [p === undefined ? "Every card drafted." : `${st.worker} is drafting ${p.card} (${done + 1} of ${st.proposals.length}); the plan goes to the Backlog when the last is drafted.`, ...noteLine, ...leftLines].join("\n")
      }
      if (st.stage === "rehearse" || st.stage === "plan") return [`Drafting the plan for ${plural(st.proposals.filter((p) => p.status === "accepted").length, "card")}; it goes to the Backlog.`, ...leftLines, ...noteLine].join("\n")
      return [`On the Backlog as **${(st.items ?? (st.item !== undefined ? [st.item] : [])).join(", ") || "a plan"}**: move it to Ready (in Backlog) to apply it.`, ...leftLines, "", "**r** starts a new round."].join("\n")
    }
    // The journeys a rehearse run walks now: their feedback is locked until it ends (it reconciles them then).
    let walking: { readonly run: string; readonly journeys: ReadonlySet<string> } | undefined
    const walkedBy = (journeys: ReadonlyArray<string>) => (walking !== undefined && journeys.some((j) => walking!.journeys.has(j)) ? walking.run : undefined)
    let journey: string | undefined
    // Background changes redraw Feedback only once it has been opened (nobody looks otherwise).
    let feedbackOpened = false
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
      // Every open entry; at Plan, not what the re-rehearse resolved. The round's entries report where they stand.
      const round = new Set(st !== undefined && st.stage !== "triage" && st.stage !== "planned" ? (st.inputs ?? []) : [])
      const shown = all_.filter((e) => !(st?.stage === "plan" && (st.results?.resolved ?? []).includes(e.id)))
      const statusOf = (e: Entry) => {
        if (walkedBy(e.journeys) !== undefined) return "rehearsing"
        if (st === undefined || !round.has(e.id)) return ""
        if (st.stage === "rehearse") return "re-rehearsing"
        if (st.stage === "plan") return "still reported"
        const p = st.proposals.find((x) => x.card === (parseRef(e.ref)?.id ?? ""))
        return p === undefined ? "" : p.status === "accepted" ? "drafted" : p.status === "skipped" ? "left out" : st.worker !== undefined ? "waiting" : "queued"
      }
      const locked = (e: Entry) => (st !== undefined && inTriage(st) && round.has(e.id)) || walkedBy(e.journeys) !== undefined
      const on = shown.filter((e) => e.triage.on).length
      // The journey and its counts; how far its triage got is triage's to show (its rows say where they stand).
      yield* views.set("feedback", FeedbackView, "stage", {
        markdown: journey === undefined ? "No open feedback. Testers file it when they rehearse." : `**${journey}** · ${plural(shown.length, "entry")} · ${on} on${walkedBy([journey]) !== undefined ? ` · being rehearsed (run ${walkedBy([journey])})` : st !== undefined && inTriage(st) ? " · in triage" : ""}`,
      })
      yield* views.set("feedback", FeedbackView, "journeys", { rows: names.map((j) => ({ id: j, cells: { journey: j, open: String(byJourney.get(j)?.length ?? 0) } })) })
      yield* views.set("feedback", FeedbackView, "work", { markdown: st === undefined ? "" : workOf(st, on) })
      const sev = { high: 0, medium: 1, low: 2 } as const
      const sorted = [...shown].sort((a, b) => sev[a.severity] - sev[b.severity] || a.id.localeCompare(b.id))
      yield* views.set("feedback", FeedbackView, "feedback", {
        // The round's entries are read-only in triage (the plugin refuses them); the rest take notes as ever.
        actions: st === undefined ? ["note"] : [...stageActions(st), "note"],
        rows: sorted.map((e) => ({
          id: e.id,
          on: e.triage.on,
          ...(locked(e) ? { readonly: true, tone: "dim" as const } : {}),
          ...(e.operatorNote !== undefined ? { text: e.operatorNote } : {}),
          cells: { card: target(e.ref), severity: e.severity, kind: e.kind, note: e.operatorNote !== undefined ? "✎" : "", status: statusOf(e) },
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
          ...(e.notReportedIn !== undefined ? ["", `Not reported by run ${e.notReportedIn}, which walked this card: yours to keep or turn off.`] : []),
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
      Effect.gen(function* () {
        // Only refs with the version the plan was drafted on (cards an apply added carry none: nothing to go stale); one lookup for all.
        const refs = [...new Set(items.filter((i) => i.status === "backlog" || i.status === "ready").flatMap((i) => i.cards.map((c) => c.ref)).filter((ref) => parseRef(ref)?.version !== undefined))]
        if (refs.length === 0) return new Set<string>()
        const got = yield* entities.many(refs).pipe(Effect.orElseSucceed(() => ({ entities: [] as ReadonlyArray<{ ref: string }> })))
        const now = new Set(got.entities.map((e) => e.ref))
        return new Set(refs.filter((r) => !now.has(r)))
      })
    const refreshBoard = Effect.gen(function* () {
      const all = yield* loadItems
      const items = all.filter((i) => i.dropped !== true)
      const changed = yield* changedRefs(items)
      const byId = (a: Item, b: Item) => (Number(a.id.slice(2)) || 0) - (Number(b.id.slice(2)) || 0)
      yield* views.set("backlog", BacklogView, "board", {
        lanes: LANES.map((lane) => ({ id: lane, title: LANE_TITLES[lane], cards: items.filter((i) => i.status === lane).sort(lane === "done" ? (a, b) => byId(b, a) : byId).map((i) => boardCard(i, all, changed)) })),
      })
      return items
    })
    let selected: string | undefined
    const short = (ref: string) => {
      const r = parseRef(ref)
      return r === undefined ? ref : `${r.id}${r.version !== undefined ? ` @${r.version.slice(0, 4)}` : ""}`
    }
    /** The drawer: the plan's header, its title, each card (its version: ✓ current, ⚠ changed), feedback, the cards as they are, changes, steps, links, events. */
    const itemMarkdown = (i: Item, feedback: ReadonlyArray<Entry>, changed: ReadonlySet<string>, contexts: ReadonlyArray<readonly [string, string]>) =>
      [
        `${i.id} · ${LANE_TITLES[i.status]}${i.agent !== undefined ? ` · ${i.agent}` : ""}`,
        `**${i.title}**`,
        ...i.cards.map((c, k) => `${short(c.ref)} ${changed.has(c.ref) ? "⚠ changed" : "✓"}${k === 0 ? `${i.persona !== undefined ? ` · ${i.persona}` : ""} · ${i.journey}${i.severity !== undefined ? ` · ${i.severity}` : ""}` : ""}`),
        ...(i.needs !== undefined ? ["", `**Needs you:** ${i.needs}`] : []),
        ...(changed.size > 0 ? ["", "A card changed since this plan was drafted: **s** Resync (it takes the cards as they are now, or goes back to triage)."] : []),
        ...(feedback.length > 0 ? ["", `**Feedback ${feedback.length}**`, ...feedback.map((f) => `◇ ${f.kind}  ${f.note}`)] : []),
        ...contexts.flatMap(([id, text]) => (text.length > 0 ? ["", `**Card** ${id}`, "```gherkin", text.trim(), "```"] : [])),
        ...(i.changes.length > 0 ? ["", `**Changes ${i.changes.length}**`, ...i.changes.map((c) => `- gherkin/${c.tool} ${JSON.stringify(c.params)}`)] : []),
        ...(i.steps.length > 0 ? ["", "**Steps**", ...i.steps.map((st, k) => `${k + 1}. ${st}`)] : []),
        ...((i.after ?? []).length > 0 ? ["", `**Links** after ${i.after!.join(", ")}`] : []),
        ...(i.events.length > 0 ? ["", "**Events**", ...i.events.map((e) => `${e.what} (${e.by})`)] : []),
      ].join("\n")
    const showItem = (id: string) =>
      Effect.gen(function* () {
        const all = yield* loadItems
        const i = all.find((x) => x.id === id)
        if (i === undefined) return false
        const feedback = (yield* load).filter((e) => i.feedback.includes(e.id))
        const changed = stale(i, all, yield* changedRefs([i]))
        // The whole picture in one call: each card it touches (new ones too), as it is, as the plan leaves it, as text.
        const own = i.cards.map((c) => parseRef(c.ref)?.id ?? "").filter((c) => /^UX-/.test(c))
        const compared = (yield* gherkin.compare({ draft: i.changes, cards: own }).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: [] as ReadonlyArray<string>, cards: [] as ReadonlyArray<{ id: string; before: null; after: null; text: string }> })))).cards
        const lines = (x: { given: string; when: string; thens: ReadonlyArray<string> } | null) => (x === null ? [] : [`Given ${x.given}`, `When  ${x.when}`, ...x.thens.map((t, k) => `${k === 0 ? "Then" : "And "}  ${t}`)])
        const diffs = compared.map((c) => ({ id: c.id, title: c.after?.title ?? c.before?.title ?? c.id, before: lines(c.before), after: lines(c.after) }))
        const contexts = compared.filter((c) => own.includes(c.id)).map((c) => [c.id, c.text] as const)
        const actions = ["move", "drop", ...(changed.size > 0 ? ["resync"] : [])]
        yield* views.set("backlog", ItemView, "item.plan", { markdown: planText(i, feedback, diffs.filter((d) => d.after.length > 0 && d.before.join("\n") !== d.after.join("\n")), changed, links(i, all)), actions })
        yield* views.set("backlog", ItemView, "item.agent", { markdown: itemMarkdown(i, feedback, changed, contexts), actions })
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
        // Its journey is as if never planned once its round's last plan is gone: nothing says Planned for plans that are gone.
        const st = (yield* loadStages).find((s) => s.journey === i.journey && (s.items ?? (s.item !== undefined ? [s.item] : [])).includes(id))
        const all = yield* loadItems
        if (st !== undefined && (st.items ?? [id]).every((x) => x === id || all.find((y) => y.id === x)?.dropped === true)) yield* saveStage(fresh(st.journey))
        return `${id} dropped; its feedback is open again`
      }).pipe(writing.withPermits(1))
    const plan = (p: PlanParams) =>
      Effect.gen(function* () {
        const id = nextId(yield* loadItems)
        // A new plan waits in Backlog until the operator moves it to Ready (the Planner takes only Ready plans).
        yield* saveItem({ ...p, id, status: "backlog", events: [{ what: "planned", by: "Triage Agent" }] })
        yield* markFeedback(p.feedback, "planned")
        return { id }
      }).pipe(writing.withPermits(1), Effect.tap(() => ready), Effect.mapError(fail))
    /** What a plan waits on (a dropped one said so) and what waits on it. */
    const links = (i: Item, all: ReadonlyArray<Item>) => ({
      after: (i.after ?? []).map((id) => (all.find((x) => x.id === id)?.dropped === true ? `${id} (dropped)` : id)),
      before: all.filter((x) => x.dropped !== true && (x.after ?? []).includes(i.id)).map((x) => x.id),
    })
    const next = () =>
      Effect.gen(function* () {
        const items = (yield* loadItems).filter((i) => i.dropped !== true)
        const changed = yield* changedRefs(items)
        return pickNext(items, (ref) => changed.has(ref)) ?? null
      }).pipe(Effect.mapError(fail))

    /** Each entry filed, or "" where it was refused (a ref without a version) or could not be saved; the rest are filed. */
    const file = ({ entries, walked, run }: { entries: ReadonlyArray<FiledEntry>; walked?: ReadonlyArray<string>; run?: string }) =>
      Effect.gen(function* () {
        const had = new Map((yield* load).map((e) => [e.id, e]))
        const ids: Array<string> = []
        // The same report: the same words, or (worded anew) an open entry on the same card version of the same kind.
        const sameAs = (f: FiledEntry) => had.get(entryId(f)) ?? [...had.values()].find((e) => e.state === undefined && e.ref === f.ref && e.kind === f.kind)
        for (const f of entries) {
          if (parseRef(f.ref)?.version === undefined) {
            ids.push("")
            continue
          }
          const e = upsert(sameAs(f), f)
          const saved = yield* Effect.match(save(e), { onFailure: () => false, onSuccess: () => true })
          if (saved) had.set(e.id, e)
          ids.push(saved ? e.id : "")
        }
        // A run that walked cards reconciles their feedback: what it did not report again closes; what the operator
        // touched (flipped, noted) or a triage round holds is only marked, the call is theirs.
        if (walked !== undefined) {
          const by = run ?? entries[0]?.from.run ?? "a run"
          const reported = new Set(ids)
          const inRound = new Set((yield* loadStages).filter(inTriage).flatMap((s) => s.inputs ?? []))
          for (const e of [...had.values()]) {
            const card = parseRef(e.ref)?.id
            if (e.state !== undefined || reported.has(e.id) || e.from.agent !== "rehearse" || card === undefined || !walked.includes(card)) continue
            const theirs = e.triage.by === "operator" || e.operatorNote !== undefined || inRound.has(e.id)
            yield* save(theirs ? { ...e, notReportedIn: by } : { ...e, state: "closed", notReportedIn: by })
          }
        }
        return { ids }
      }).pipe(writing.withPermits(1), Effect.mapError(fail))
    const status = ({ ids }: { ids: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        const all = yield* withStates((yield* load).filter((e) => ids.includes(e.id)))
        return all.map((x) => ({ id: x.e.id, state: x.state, on: x.e.triage.on }))
      })
    const boardAct = (action: string, rows: ReadonlyArray<string>, text?: string) =>
      Effect.gen(function* () {
        if (action === "item" && rows[0] !== undefined) {
          selected = rows[0]
          // The drawer opens at once, loading (never the plan shown before); the plan follows.
          const loading = { markdown: "", loading: `Loading ${rows[0]}…` }
          yield* views.set("backlog", ItemView, "item.plan", loading)
          yield* views.set("backlog", ItemView, "item.agent", loading)
          yield* surfaces.open({ surface: "item", agent: "backlog", focus: true })
          if (!(yield* showItem(rows[0]))) return `no plan ${rows[0]}`
          return rows[0]
        }
        if ((action === "move-left" || action === "move-right") && rows[0] !== undefined) {
          const i = (yield* loadItems).find((x) => x.id === rows[0])
          return i === undefined ? `no plan ${rows[0]}` : yield* move(i.id, neighbour(i.status, action === "move-right" ? 1 : -1), "operator")
        }
        // The drawer's buttons act on the plan it shows.
        // The drawer follows its plan; once the plan is dropped (Drop, or a Resync that sends it back to triage), it closes.
        const after = (id: string) =>
          Effect.gen(function* () {
            if ((yield* loadItems).find((x) => x.id === id)?.dropped === true) {
              selected = undefined
              return yield* surfaces.close("item", "backlog")
            }
            yield* showItem(id)
          })
        if (selected !== undefined && action === "resync") {
          const id = selected
          const notice = yield* resync(id)
          yield* after(id)
          return notice
        }
        // Move ▾: to the lane picked (its text); Drop.
        if (selected !== undefined && ((action === "move" && (LANES as ReadonlyArray<string>).includes(text ?? "")) || action === "drop")) {
          const id = selected
          const notice = action === "drop" ? yield* drop(id) : yield* move(id, text as Item["status"], "operator")
          yield* after(id)
          return notice
        }
        return action === "open" ? "Backlog" : `nothing to ${action}`
      })
    // One Backlog plan at a time: a double press never backlogs the stage twice.
    const planning = yield* Semaphore.make(1)
    /** The drafted plan to the Backlog (its Backlog lane, until the operator moves it to Ready): the draft, the cards it changes (at their versions now), the feedback it answers. */
    const toBacklog = (j: string) =>
      Effect.gen(function* () {
          const st = yield* stageOf(j)
          if (st.stage !== "plan" || st.plan === undefined) return `${j} has no plan yet`
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
          const cards = yield* Effect.forEach([...new Set([...(st.cards ?? []), ...accepted.map((p) => p.card)])].filter((c) => /^UX-/.test(c)), (c) => Effect.map(entities.version(`gherkin/card:${c}`).pipe(Effect.orElseSucceed(() => null)), (v) => (v === null ? [] : [{ ref: `gherkin/card:${c}@${v}` }])))
          const worst = closes.map((e) => e.severity).sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b))[0]
          const { id } = yield* plan({ title: st.plan.title, journey: j, cards: cards.flat(), changes: st.draft, feedback: closes.map((e) => e.id), steps: st.plan.steps, ...(closes[0] !== undefined ? { persona: closes[0].persona } : {}), ...(worst !== undefined ? { severity: worst } : {}) })
          yield* updateStage(j, (x) => ({ ...x, stage: "planned", item: id }))
          return `${j}: backlogged as ${id}`
      }).pipe(planning.withPermits(1))
    /** A folded round's plans to the Backlog lane, in order: each with its cards at their versions now and the plans it waits on by id; the journey planned with all of them. */
    const plans = (p: typeof PlansParams.Type) =>
      Effect.gen(function* () {
        const entries = yield* load
        const rank = (x: string) => ["high", "medium", "low"].indexOf(x)
        const ids: Array<string> = []
        for (const x of p.plans) {
          const closes = entries.filter((e) => x.feedback.includes(e.id))
          const worst = closes.map((e) => e.severity).sort((a, b) => rank(a) - rank(b))[0]
          const cards = yield* Effect.forEach(x.cards.filter((c) => /^UX-/.test(c)), (c) => Effect.map(entities.version(`gherkin/card:${c}`).pipe(Effect.orElseSucceed(() => null)), (v) => (v === null ? [] : [{ ref: `gherkin/card:${c}@${v}` }])))
          const after = x.after.flatMap((k) => (ids[k] !== undefined ? [ids[k]!] : []))
          const { id } = yield* plan({ title: x.title, journey: p.journey, cards: cards.flat(), changes: x.changes, feedback: x.feedback, steps: x.steps, ...(after.length > 0 ? { after } : {}), ...(closes[0] !== undefined ? { persona: closes[0].persona } : {}), ...(worst !== undefined ? { severity: worst } : {}) })
          ids.push(id)
        }
        yield* updateStage(p.journey, (st) => {
          const { item: _, ...rest } = st
          return { ...rest, stage: "planned", items: ids }
        })
        return { ids }
      }).pipe(planning.withPermits(1), Effect.tap(() => Effect.ignore(Effect.suspend(() => (feedbackOpened ? refresh : Effect.void)))), Effect.mapError(fail))
    const stageAct = (j: string, action: string) =>
      Effect.gen(function* () {
        if (action === "refine") {
          if (walkedBy([j]) !== undefined) return `${j} is being rehearsed (run ${walkedBy([j])}): Refine when the run ends`
          const entries = yield* openIn(j)
          const st0 = yield* stageOf(j)
          // From Plan, or out of a re-rehearse that hangs: again, over the draft so far.
          if (st0.stage === "plan" || st0.stage === "rehearse") {
            const refused = yield* updateStage(j, (st) => refineAgain(st, entries), true)
            if (refused !== undefined) return refused
            return `${j}: refining ${plural((yield* stageOf(j)).proposals.filter((p) => p.status === "waiting").length, "card")} again`
          }
          const seq = nextQueued(yield* loadStages)
          const refused = yield* updateStage(j, (st) => {
            if (st.stage !== "triage" && st.stage !== "planned") return `${j} is in triage already`
            const r = startRefine(st, entries)
            if (typeof r === "string") return r
            const { worker: _w, ...rest } = r
            return { ...rest, queued: seq }
          }, true)
          if (refused !== undefined) return refused
          return `${j}: ${stageLabel(yield* stageOf(j), yield* loadStages)} · ${plural(new Set(entries.filter((e) => e.triage.on).map((e) => target(e.ref))).size, "card")}`
        }
        return `nothing to ${action}`
      })
    /** Resync a plan whose cards changed: its changes still fit → the cards' versions now; they do not → back to triage (its feedback moved to the cards as they are, the plan dropped, the journey queued). */
    const resync = (id: string) =>
      Effect.gen(function* () {
        const i = (yield* loadItems).find((x) => x.id === id)
        if (i === undefined) return `no plan ${id}`
        const changed = yield* changedRefs([i])
        if (changed.size === 0) return `${id}'s cards are as it was drafted on: nothing to resync`
        const dry = yield* gherkin.dryRun({ draft: i.changes }).pipe(Effect.orElseSucceed(() => ({ ok: false, problems: ["the dry-run failed"] as ReadonlyArray<string> })))
        if (dry.ok) {
          const cards = yield* Effect.forEach(i.cards, (c) => (changed.has(c.ref) ? Effect.map(entities.version(target(c.ref)).pipe(Effect.orElseSucceed(() => null)), (v) => ({ ...c, ref: v === null ? c.ref : `${target(c.ref)}@${v}` })) : Effect.succeed(c)))
          yield* saveItem({ ...i, cards, events: [...i.events, { what: "resynced: its changes still fit the cards as they are now", by: "operator" }] })
          return `${id} resynced: its changes still fit the cards as they are now`
        }
        // Its feedback moves to the cards as they are now (the old version's entries close); the rest opens again.
        const moved_ = yield* Effect.gen(function* () {
          const out: Array<string> = []
          for (const e of (yield* load).filter((x) => i.feedback.includes(x.id))) {
            const v = yield* entities.version(target(e.ref)).pipe(Effect.orElseSucceed(() => null))
            const ref = v === null ? e.ref : `${target(e.ref)}@${v}`
            if (ref === e.ref) continue
            const { id: _i, count: _c, state: _s, runs: _r, triage, operatorNote, ...filed } = e
            const next = upsert(undefined, { ...filed, ref, triage: { on: triage.on, why: triage.why } })
            yield* save({ ...next, triage, ...(operatorNote !== undefined ? { operatorNote } : {}) })
            out.push(e.id)
          }
          yield* markFeedback(out, "closed")
          yield* markFeedback(i.feedback.filter((f) => !out.includes(f)), undefined)
          return out
        }).pipe(writing.withPermits(1))
        yield* saveItem({ ...i, dropped: true, events: [...i.events, { what: `no longer fits (${dry.problems.join("; ")}): back to triage with ${plural(moved_.length, "entry")} moved to the cards as they are`, by: "operator" }] })
        const refused = yield* stageAct(i.journey, "refine")
        const label = stageLabel(yield* stageOf(i.journey), yield* loadStages)
        return `${id} no longer fits (${dry.problems.join("; ")}): back to triage, ${label.startsWith("queued") ? `${i.journey} ${label}` : refused}`
      })
    const act = ({ agent, action, rows, text }: { agent: string; action: string; rows: ReadonlyArray<string>; text?: string }) =>
      Effect.gen(function* () {
        if (agent === "backlog") {
          const notice = yield* boardAct(action, rows, text)
          // Opening a plan changes nothing on the board: no redraw.
          if (action !== "item") yield* refreshBoard
          return { notice }
        }
        if (agent !== "feedback") return { notice: `backlog has no view ${agent}` }
        if (action === "journey" && rows[0] !== undefined) journey = rows[0]
        // The view opens with its cursor on the first journey: show that one.
        if (action === "open") {
          journey = undefined
          feedbackOpened = true
        }
        // Feedback of a journey in triage is read-only until Plan.
        if (action === "note" || action === "toggle") {
          // A journey a run walks now: locked until the run ends (it reconciles its feedback then).
          const walked = (yield* load).filter((e) => rows.includes(e.id)).flatMap((e) => e.journeys).find((j) => walkedBy([j]) !== undefined)
          if (walked !== undefined) return { notice: `${walked} is being rehearsed (run ${walkedBy([walked])}): its feedback is read-only until the run ends` }
          const stages = yield* loadStages
          const inRound = stages.find((s) => inTriage(s) && (s.inputs ?? []).some((id) => rows.includes(id)))
          if (inRound !== undefined) return { notice: `in ${inRound.journey}'s triage round: read-only until Plan` }
        }
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
        if (action === "refine") {
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
    const moved_ = <E>(e: Effect.Effect<unknown, E>) => nul(Effect.andThen(e, Effect.ignore(Effect.suspend(() => (feedbackOpened ? refresh : Effect.void)))))
    return {
      file,
      status,
      act,
      agenda,
      stages: () => loadStages.pipe(Effect.mapError(fail)),
      feedbackOf: ({ journey: j }: { journey: string }) => Effect.map(openIn(j), (es) => es.map((e) => ({ id: e.id, ref: e.ref, kind: e.kind, severity: e.severity, note: e.note, persona: e.persona, on: e.triage.on, ...(e.operatorNote !== undefined ? { operatorNote: e.operatorNote } : {}) }))).pipe(Effect.mapError(fail)),
      redraft: (p: typeof Redraft.Type) => moved_(updateStage(p.journey, (st) => (st.stage === "rehearse" || st.stage === "plan" ? redraft(st, p.problems) : st), true)),
      walking: (p: { run: string; journeys: ReadonlyArray<string> }) =>
        Effect.gen(function* () {
          if (p.journeys.length > 0) walking = { run: p.run, journeys: new Set(p.journeys) }
          else if (walking?.run === p.run) walking = undefined
          if (feedbackOpened) yield* Effect.ignore(refresh)
          return null
        }),
      assign: (p: { journey: string; worker?: string }) =>
        moved_(updateStage(p.journey, (st) => {
          const { worker: _w, ...rest } = st
          return p.worker !== undefined ? { ...rest, worker: p.worker } : rest
        })),
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
            // `clear`: the run is gone (stopped); the next wake starts another. `dropped`: the left-behind run is stopped.
            if (p.dropped === true) {
              const { dropRun: _d, ...kept } = st
              return kept
            }
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
      // The drafted plan goes straight to the Backlog: it waits in its Backlog lane until the operator moves it to Ready.
      plans,
      drafted: (p: typeof Drafted.Type) => moved_(Effect.andThen(updateStage(p.journey, (st) => ({ ...st, plan: { title: p.title, steps: p.steps } })), toBacklog(p.journey))),
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
