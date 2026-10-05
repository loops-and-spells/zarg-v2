import { Effect, Schema } from "effect"
import { type Change, diff, Snapshot } from "@zarg/graph/pure"
import { affectedScenarios } from "./affected"
import { bareIds, type Finding, type Lint, type Tool } from "./kit"
import { STATE } from "./model"

/** Edge limits per edge type (the plugin's graph spec): the host checks them on every write. */
export type EdgeLimits = Readonly<Record<string, { readonly from: string; readonly min?: number; readonly max?: number }>>
/** A node's edges against the limits, as the host's structural check would find them. */
const structure = (snap: Snapshot.Snapshot, ids: ReadonlyArray<string>, limits: EdgeLimits) =>
  ids.flatMap((id) => {
    const n = snap.nodes.get(id)
    if (n === undefined) return []
    const own = Object.entries(limits).filter(([, l]) => n.type === `gherkin/${l.from}`)
    return [
      ...own.flatMap(([edge, l]) => {
        const count = n.edges.filter((e) => e.type === `gherkin/${edge}`).length
        return (l.min !== undefined && count < l.min) || (l.max !== undefined && count > l.max) ? [`${id} has ${count} ${edge} edge${count === 1 ? "" : "s"}; it needs ${l.min ?? 0}${l.max !== undefined ? `-${l.max}` : " or more"}`] : []
      }),
      ...n.edges.filter((e) => !snap.nodes.has(e.to)).map((e) => `${id} points at ${e.to}, which is not in the graph`),
    ]
  })

/** A draft: gherkin tool calls, in order, applied over the graph in memory (it never writes the graph). */
export type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>

/**
 * The graph as it would be after a draft: each call runs on the snapshot the calls before it made, so a scenario can
 * arrive from a state added earlier in the same draft (the same ids the Planner gets applying it in order).
 */
export const applyDraft = (snap: Snapshot.Snapshot, draft: Draft, tools: ReadonlyArray<Tool>, limits?: EdgeLimits) =>
  Effect.gen(function* () {
    let now = snap
    const changes: Array<Change> = []
    const messages: Array<string> = []
    const problems: Array<string> = []
    for (const c of draft) {
      const t = tools.find((x) => x.name === c.tool)
      if (t === undefined) {
        problems.push(`${c.tool} is not a gherkin tool`)
        continue
      }
      const params = Schema.decodeUnknownExit(t.params)(bareIds(c.params))
      if (params._tag === "Failure") {
        problems.push(`${c.tool}: its params do not fit: ${String(params.cause)}`)
        continue
      }
      const r = yield* Effect.exit(t.run(params.value, now))
      if (r._tag === "Failure") {
        const e = r.cause.reasons.find((x) => x._tag === "Fail") as { error?: { message?: string } } | undefined
        problems.push(`${c.tool}: ${e?.error?.message ?? "failed"}`)
        continue
      }
      const next = Snapshot.applyChanges(now, r.value.changes)
      // As a write would: each call's result must hold the graph's edge limits (a later call cannot repair it).
      const broken = limits === undefined ? [] : structure(next, r.value.changes.map((ch) => (ch._tag === "Put" ? ch.node.id : ch.id)), limits)
      if (broken.length > 0) {
        problems.push(...broken.map((b) => `${c.tool}: ${b}`))
        continue
      }
      now = next
      changes.push(...r.value.changes)
      messages.push(r.value.message)
    }
    return { snapshot: now, changes, messages, problems }
  })

/** A draft checked as the write pipeline would: its tools, the props it writes, and every lint over what changed. */
export const dryRun = (snap: Snapshot.Snapshot, draft: Draft, tools: ReadonlyArray<Tool>, validate: (changes: ReadonlyArray<Change>) => ReadonlyArray<Finding>, lints: ReadonlyArray<Lint>, limits?: EdgeLimits) =>
  Effect.map(applyDraft(snap, draft, tools, limits), (a) => {
    const d = diff(snap, a.snapshot)
    const findings = [...validate(a.changes), ...lints.flatMap((l) => l({ before: snap, after: a.snapshot, diff: d }))].filter((f) => f.severity === "error")
    // A state the draft adds and leaves unused: a scenario should take it (Given, And or Then), or it goes.
    const unused = d.added
      .filter((n) => n.type === STATE && Snapshot.inbound(a.snapshot, n.id).length === 0)
      .map((n) => `${n.id} "${String(n.props.text ?? "")}" is added but no scenario uses it: drop it, or use it as a Given, And or Then`)
    const problems = [...a.problems, ...findings.map((f) => f.message), ...unused]
    // What the draft changes, not what it puts: a call that puts a node as it is touches nothing.
    const touched = [...d.added, ...d.changed, ...d.removed].map((n) => n.id).sort()
    // The scenarios to re-implement: added or changed, or using a reworded state (as the reconcile loop will see it).
    const scenarios = affectedScenarios(snap, a.snapshot).scenarios
    const id = (prefix: string) => Snapshot.nextId(a.snapshot, prefix)
    // @scenario S-0103
    const next = { scenario: id("S"), state: id("ST"), journey: id("J"), persona: id("P") }
    return { ok: problems.length === 0, problems, touched, scenarios, messages: a.messages, next }
  })
