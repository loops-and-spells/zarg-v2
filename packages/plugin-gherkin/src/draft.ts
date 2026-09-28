import { Effect, Schema } from "effect"
import { type Change, diff, Snapshot } from "@zarg/graph/pure"
import type { Finding, Lint, Tool } from "./kit"

/** A draft: gherkin tool calls, in order, applied over the graph in memory (it never writes the graph). */
export type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>

/**
 * The graph as it would be after a draft: each call runs on the snapshot the calls before it made, so a card can
 * arrive from a state added earlier in the same draft (the same ids the Planner gets applying it in order).
 */
export const applyDraft = (snap: Snapshot.Snapshot, draft: Draft, tools: ReadonlyArray<Tool>) =>
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
      const params = Schema.decodeUnknownExit(t.params)(c.params)
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
      now = Snapshot.applyChanges(now, r.value.changes)
      changes.push(...r.value.changes)
      messages.push(r.value.message)
    }
    return { snapshot: now, changes, messages, problems }
  })

/** A draft checked as the write pipeline would: its tools, the props it writes, and every lint over what changed. */
export const dryRun = (snap: Snapshot.Snapshot, draft: Draft, tools: ReadonlyArray<Tool>, validate: (changes: ReadonlyArray<Change>) => ReadonlyArray<Finding>, lints: ReadonlyArray<Lint>) =>
  Effect.map(applyDraft(snap, draft, tools), (a) => {
    const d = diff(snap, a.snapshot)
    const findings = [...validate(a.changes), ...lints.flatMap((l) => l({ before: snap, after: a.snapshot, diff: d }))].filter((f) => f.severity === "error")
    const problems = [...a.problems, ...findings.map((f) => f.message)]
    const touched = [...new Set(a.changes.map((c) => (c._tag === "Put" ? c.node.id : c.id)))]
    return { ok: problems.length === 0, problems, touched, messages: a.messages }
  })
