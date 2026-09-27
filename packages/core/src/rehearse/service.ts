import { Effect, Schema } from "effect"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"
import { git, gitRun } from "@zarg/reconcile"
import type { askFirst } from "../driver"
import type { Rehearse } from "./run"

export const RehearseDef = defineService("Rehearse", "Rehearsals: testers walk the journeys and report findings for you to triage.", {
  run: {
    doc: "Start a rehearsal in the background (when the graph is ready, or the developer asks). Findings come back as an agenda item.",
    params: Schema.Struct({
      strategy: Schema.optionalKey(Schema.Literals(["edge-pair", "teleport"])).annotate({ description: "edge-pair (default): every journey step and step pair; teleport: each card once, alone (quick)." }),
      focus: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Card or state ids: only stories through them." }),
    }),
    success: Schema.Struct({ run: Schema.String, stories: Schema.Number, steps: Schema.Number, personas: Schema.Array(Schema.String) }),
  },
  fix: {
    doc: "Take up a [fix] finding: checks it still holds and opens graph writes for it until your next question. Then change the Gherkin graph to resolve it.",
    params: Schema.Struct({ finding: Schema.String }),
    success: Schema.Struct({ id: Schema.String, card: Schema.String, kind: Schema.String, notes: Schema.Array(Schema.String) }),
  },
  resolve: {
    doc: "Finish a run's triage: commits the graph changes you made for its findings in one commit and takes the run off the agenda.",
    params: Schema.Struct({ run: Schema.String, applied: Schema.Array(Schema.String), dismissed: Schema.Array(Schema.String) }),
    success: Schema.Struct({ commit: Schema.optionalKey(Schema.String) }),
  },
})

const fail = (_tag: string, message: string): ServiceFailure => ({ _tag, message })

export const rehearseService = (ctx: {
  readonly rehearse: Pick<Rehearse, "start" | "findingOf" | "markResolved">
  readonly guard: ReturnType<typeof askFirst>
  readonly stepNow: (card: string) => Effect.Effect<Record<string, unknown> | undefined>
  readonly commit: (ids: ReadonlyArray<string>, message: string) => Effect.Effect<string | undefined, ServiceFailure>
}): Bound =>
  bind(RehearseDef, {
    run: (p) => Effect.flatMap(ctx.rehearse.start(p), (r) => ("refused" in r ? Effect.fail(fail("Busy", r.refused)) : Effect.succeed(r))),
    fix: ({ finding }) =>
      Effect.gen(function* () {
        const hit = ctx.rehearse.findingOf(finding)
        if (hit === undefined) return yield* Effect.fail(fail("NotFound", `no finding ${finding}`))
        if (hit.f.route !== "fix") {
          return yield* Effect.fail(fail("NotAFix", `${finding} is [${hit.f.route}]: ${hit.f.route === "ask" ? "Inquire.confirm the change with the developer" : "dismiss it in Rehearse.resolve"}`))
        }
        // The card must still be there; a finding about a card gone since the run is stale.
        const now = yield* ctx.stepNow(hit.f.card)
        if (now === undefined) return yield* Effect.fail(fail("Stale", `${hit.f.card} is gone since the run; dismiss ${finding}`))
        ctx.guard.openFor()
        return { id: hit.f.id, card: hit.f.card, kind: hit.f.kind, notes: [...hit.f.notes] }
      }),
    resolve: ({ run, applied, dismissed }) =>
      Effect.gen(function* () {
        const ids = [...ctx.guard.touched()]
        const commit = ids.length > 0 ? yield* ctx.commit(ids, `req: rehearse ${run}: applied ${applied.join(", ") || "none"}`) : undefined
        ctx.rehearse.markResolved(run, [...applied, ...dismissed], true)
        return commit !== undefined ? { commit } : {}
      }),
  })

/** Commit exactly these graph nodes' files (added, changed or removed); the developer's other edits stay out. */
export const commitGraph = (root: string, ids: ReadonlyArray<string>, message: string) =>
  Effect.gen(function* () {
    const paths = ids.map((id) => `.zarg/graph/nodes/${id}.json`)
    yield* git(root, ["add", "-A", "--", ...paths])
    const staged = yield* gitRun(root, ["diff", "--cached", "--quiet", "--", ...paths])
    if (staged.code === 0) return undefined
    yield* git(root, ["commit", "-q", "-m", message, "--", ...paths])
    return yield* git(root, ["rev-parse", "HEAD"])
  }).pipe(Effect.mapError((e): ServiceFailure => fail("CommitFailed", e.message)))
