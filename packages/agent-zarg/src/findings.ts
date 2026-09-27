import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"
import { git, gitRun } from "@zarg/reconcile"
import type { askFirst } from "./driver"
import type { ChosenFindings } from "@zarg/core"

export const FindingsDef = defineService("Findings", "Findings plugins reported (a rehearsal's testers) that the developer chose to apply.", {
  take: {
    doc: "Take up a finding the developer chose: checks it still holds and opens graph writes for its card until your next question. Then change the Gherkin graph to resolve it.",
    params: Schema.Struct({ plugin: Schema.String, finding: Schema.String }),
    success: Schema.Struct({ id: Schema.String, card: Schema.String, notes: Schema.Array(Schema.String) }),
  },
  resolve: {
    doc: "Finish a run's findings: commits the graph changes you made for them in one commit and tells the plugin which you applied or dismissed.",
    params: Schema.Struct({ plugin: Schema.String, run: Schema.String, applied: Schema.Array(Schema.String), dismissed: Schema.Array(Schema.String) }),
    success: Schema.Struct({ commit: Schema.optionalKey(Schema.String) }),
  },
})

const fail = (_tag: string, message: string): ServiceFailure => ({ _tag, message })


type Invoke = (plugin: string, method: string, params: unknown) => Effect.Effect<unknown, unknown>
interface Found { readonly run: string; readonly card: string; readonly chosen: boolean; readonly stale: boolean; readonly notes: ReadonlyArray<string> }

/**
 * The driver's side of plugin findings: a plugin never opens the write gate or commits; the driver does, here,
 * for findings the developer chose. Nodes a fix touches are kept per plugin and run on disk, so a triage spread
 * over driver items commits them all.
 */
export const findingsService = (ctx: {
  readonly dir: string
  readonly invoke: Invoke
  readonly guard: ReturnType<typeof askFirst>
  /** What the developer applied, as the core recorded it. */
  readonly chosen: ChosenFindings
  /** A plugin zarg ships: its own `chosen` (auto_apply) counts too. */
  readonly trusted: (plugin: string) => boolean
  /** The card's states (its edges' targets): what a fix may change besides the card. */
  readonly neighbors: (card: string) => Effect.Effect<ReadonlyArray<string>>
  readonly commit: (ids: ReadonlyArray<string>, message: string) => Effect.Effect<string | undefined, ServiceFailure>
}): Bound => {
  const file = (plugin: string, run: string) => join(ctx.dir, `${plugin}-${run}.json`.replace(/[^A-Za-z0-9._-]/g, "_"))
  const touchedOf = (plugin: string, run: string): ReadonlyArray<string> => {
    try {
      return existsSync(file(plugin, run)) ? (JSON.parse(readFileSync(file(plugin, run), "utf8")) as ReadonlyArray<string>) : []
    } catch {
      return []
    }
  }
  const markTouched = (plugin: string, run: string, ids: ReadonlyArray<string>) => {
    mkdirSync(ctx.dir, { recursive: true })
    writeFileSync(file(plugin, run), JSON.stringify([...new Set([...touchedOf(plugin, run), ...ids])].sort()))
  }
  return bind(FindingsDef, {
    take: ({ plugin, finding }) =>
      Effect.gen(function* () {
        const f = (yield* ctx.invoke(plugin, "finding", { id: finding }).pipe(Effect.mapError((e) => fail("NotFound", String((e as { message?: string }).message ?? e))))) as Found | null
        if (f === null || f === undefined) return yield* Effect.fail(fail("NotFound", `${plugin} has no finding ${finding}`))
        if (!f.chosen || !(ctx.trusted(plugin) || ctx.chosen.has(plugin, finding))) return yield* Effect.fail(fail("NotChosen", `${finding} was not chosen to apply: the developer picks findings in the agents pane; Inquire.confirm any other change`))
        if (f.stale) return yield* Effect.fail(fail("Stale", `${f.card} changed or is gone since ${finding} was found; dismiss it in Findings.resolve`))
        ctx.guard.openFor({ allowed: [f.card, ...(yield* ctx.neighbors(f.card))], onTouched: (ids) => markTouched(plugin, f.run, ids) })
        return { id: finding, card: f.card, notes: [...f.notes] }
      }),
    resolve: ({ plugin, run, applied, dismissed }) =>
      Effect.gen(function* () {
        const ids = [...touchedOf(plugin, run)]
        const commit = ids.length > 0 ? yield* ctx.commit(ids, `req: ${plugin} ${run}: applied ${applied.join(", ") || "none"}`) : undefined
        yield* ctx.invoke(plugin, "resolved", { run, ids: [...applied, ...dismissed] }).pipe(Effect.ignore)
        rmSync(file(plugin, run), { force: true })
        ctx.chosen.drop(plugin, [...applied, ...dismissed])
        return commit !== undefined ? { commit } : {}
      }),
  })
}

/** Commit exactly these graph nodes' files (added, changed or removed); the developer's other edits stay out. */
export const commitGraph = (root: string, ids: ReadonlyArray<string>, message: string) =>
  Effect.gen(function* () {
    // Only files there now or known to git: a node a fix added and removed again has neither.
    const tracked = new Set((yield* git(root, ["ls-files", "--", ...ids.map((id) => `:(literal).zarg/graph/nodes/${id}.json`)])).split("\n").filter((l) => l.length > 0))
    const paths = ids.map((id) => `.zarg/graph/nodes/${id}.json`).filter((p) => existsSync(join(root, p)) || tracked.has(p)).map((p) => `:(literal)${p}`)
    if (paths.length === 0) return undefined
    yield* git(root, ["add", "-A", "--", ...paths])
    const staged = yield* gitRun(root, ["diff", "--cached", "--quiet", "--", ...paths])
    if (staged.code === 0) return undefined
    yield* git(root, ["commit", "-q", "-m", message, "--", ...paths])
    return yield* git(root, ["rev-parse", "HEAD"])
  }).pipe(Effect.mapError((e): ServiceFailure => fail("CommitFailed", e.message)))
