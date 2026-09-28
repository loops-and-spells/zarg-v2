import { Effect, Schema, Semaphore } from "effect"
import { Agenda, Config, definePlugin, Entities, Files, PluginFailure, Surfaces, Views } from "@zarg/plugin-sdk"
import { Backlog, FiledEntry, ItemData, Lane, Moved, PlanParams } from "./contract"
import { parseRef } from "@zarg/entities"
import { ENTRY_ID, type Entry, entryId, stateOf, target, upsert } from "./feedback"
import { boardCard, type Item, ITEM_ID, LANE_TITLES, LANES, moved, neighbour, nextId, pickNext } from "./items"
import { BacklogView, FeedbackView, ItemView } from "./views"

const DIR = ".zarg/feedback"
const ITEMS = ".zarg/backlog"
const STAGES = ["Triage", "Refine", "Re-rehearse", "Plan"] as const
const Notice = Schema.Struct({ notice: Schema.String })
const Act = Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) })
const EntryData = Schema.Struct({
  ...FiledEntry.fields,
  id: Schema.String,
  count: Schema.Number,
  triage: Schema.Struct({ on: Schema.Boolean, why: Schema.String, by: Schema.Literals(["agent", "operator"]) }),
  state: Schema.optionalKey(Schema.Literals(["planned", "closed"])),
  runs: Schema.optionalKey(Schema.Array(Schema.String)),
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
  scopes: { agents: true, fs: { read: [`${DIR}/**`, `${ITEMS}/**`], write: [`${DIR}/**`, `${ITEMS}/**`] }, entities: { read: ["gherkin/*"] } },
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
      Effect.forEach(es, (e) =>
        e.state !== undefined
          ? Effect.succeed({ e, state: e.state })
          : Effect.map(entities.changed(e.ref).pipe(Effect.orElseSucceed(() => true)), (changed) => ({ e, state: stateOf(e, changed) })), { concurrency: 8 })

    let journey: string | undefined
    const refresh = Effect.gen(function* () {
      const all = yield* withStates(yield* load)
      const open = all.filter((x) => x.state === "open").map((x) => x.e)
      const byJourney = new Map<string, Array<Entry>>()
      for (const e of open) for (const j of e.journeys.length > 0 ? e.journeys : [NO_JOURNEY]) byJourney.set(j, [...(byJourney.get(j) ?? []), e])
      const names = [...byJourney.keys()].sort((a, b) => (a === NO_JOURNEY ? 1 : b === NO_JOURNEY ? -1 : a.localeCompare(b)))
      if (journey === undefined || !byJourney.has(journey)) journey = names[0]
      const shown = journey === undefined ? [] : byJourney.get(journey)!
      const on = shown.filter((e) => e.triage.on).length
      const stepper = STAGES.map((s, i) => (i === 0 ? `**● ${s}**` : `○ ${s}`)).join("  ───  ")
      yield* views.set("feedback", FeedbackView, "stage", {
        markdown: journey === undefined ? `${stepper}\n\nNo open feedback. Testers file it when they rehearse.` : `${stepper}\n\n**${journey}** · ${plural(shown.length, "entry")} · ${on} on`,
      })
      yield* views.set("feedback", FeedbackView, "journeys", { rows: names.map((j) => ({ id: j, cells: { journey: j, open: String(byJourney.get(j)!.length), stage: "Triage" } })) })
      const sev = { high: 0, medium: 1, low: 2 } as const
      const sorted = [...shown].sort((a, b) => sev[a.severity] - sev[b.severity] || a.id.localeCompare(b.id))
      yield* views.set("feedback", FeedbackView, "feedback", {
        rows: sorted.map((e) => ({
          id: e.id,
          on: e.triage.on,
          cells: { card: target(e.ref), severity: e.severity, kind: e.kind, feedback: e.note, why: `${e.triage.by === "operator" ? "you" : "agent"}: ${e.triage.why}` },
          search: [e.id, e.ref, e.persona, e.kind, e.severity, e.note, ...e.journeys].join(" "),
        })),
      })
      const contexts = yield* Effect.forEach(sorted, (e) => Effect.map(entities.context(target(e.ref)).pipe(Effect.orElseSucceed(() => "")), (c) => [e.id, c] as const), { concurrency: 8 })
      const detail = (e: Entry, context: string) =>
        [
          `**${e.kind} · ${e.severity}** · ${e.triage.on ? "on" : "off"} (${e.triage.by === "operator" ? "your call" : "the agent's call"}: ${e.triage.why})`,
          "",
          e.note,
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
        Effect.forEach([...new Set(items.filter((i) => i.status === "backlog" || i.status === "ready").flatMap((i) => i.cards.map((c) => c.ref)))], (ref) =>
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
    const move = (id: string, to: Item["status"], by: string, what?: string, needs?: string) =>
      Effect.gen(function* () {
        const i = (yield* loadItems).find((x) => x.id === id)
        if (i === undefined) return `no plan ${id}`
        if (i.status === to && needs === undefined) return `${id} is already in ${LANE_TITLES[to]}`
        const next = moved(i, to, by, what)
        yield* saveItem(needs !== undefined ? { ...next, needs } : next)
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
    const act = ({ agent, action, rows }: { agent: string; action: string; rows: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        if (agent === "backlog") {
          const notice = yield* boardAct(action, rows)
          yield* refreshBoard
          return { notice }
        }
        if (agent !== "feedback") return { notice: `backlog has no view ${agent}` }
        if (action === "journey" && rows[0] !== undefined) journey = rows[0]
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
    return {
      file,
      status,
      act,
      agenda,
      plan,
      next,
      moved: ({ id, to, by, what, needs }: { id: string; to: Item["status"]; by: string; what?: string; needs?: string }) => Effect.as(move(id, to, by, what, needs), null).pipe(Effect.mapError(fail)),
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
