import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Context, Effect, Layer, Schema } from "effect"
import { GraphStore, hash, layer as graphLayer, type Snapshot } from "@zarg/graph"
import type { Bound } from "@zarg/kernel"
import { ConfigError, redact, type SensitiveValue } from "@zarg/model"
import { PluginHost } from "@zarg/plugin/server"
import { type Findings, GRAPH, gitRun, type ItemOutcome, type ReconcileSpec } from "@zarg/reconcile"
import { fs, fsRead, graph, type Rlm, runCommand, type Scope, sh, verify } from "@zarg/rlm"

/** `[reconcile]` in `.zarg/config.toml`. */
export const ReconcileConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  quiet_ms: Schema.optionalKey(Schema.Number),
  max_parallel: Schema.optionalKey(Schema.Number),
  setup: Schema.optionalKey(Schema.String),
  verify: Schema.optionalKey(Schema.String),
  fix_attempts: Schema.optionalKey(Schema.Number),
  land_retry_ms: Schema.optionalKey(Schema.Number),
  land_attempts: Schema.optionalKey(Schema.Number),
})

export interface ReconcileSettings {
  readonly enabled: boolean
  readonly quietMs: number
  readonly maxParallel: number
  readonly setup: string | undefined
  readonly verify: string
  readonly fixAttempts: number
  readonly landRetryMs: number
  readonly landAttempts: number
}

export const reconcileSettings = (raw: unknown) =>
  Effect.map(
    Schema.decodeUnknownEffect(ReconcileConfig)(raw ?? {}).pipe(Effect.mapError((e) => new ConfigError({ message: `[reconcile]: ${e.message}`, key: "reconcile" }))),
    (c): ReconcileSettings => ({
      enabled: c.enabled ?? true,
      quietMs: c.quiet_ms ?? 2000,
      maxParallel: c.max_parallel ?? 4,
      setup: c.setup,
      verify: c.verify ?? "mise run verify",
      fixAttempts: c.fix_attempts ?? 2,
      landRetryMs: c.land_retry_ms ?? 60_000,
      landAttempts: c.land_attempts ?? 10,
    }),
  )

/**
 * Whether plan and implement run for a project: only with a `[reconcile]` section (not `enabled = false`),
 * models for `roles.plan` and `roles.implement`, and the project at the top of a git repository.
 */
export const reconcileGate = (root: string, extra: Readonly<Record<string, unknown>>, roles: Readonly<Record<string, string>>, opts: { readonly force?: boolean } = {}) =>
  Effect.gen(function* () {
    // `force` (the /reconcile command) overrides a missing section and `enabled = false`, nothing else.
    if (extra.reconcile === undefined && !opts.force) return { on: false, reason: "plan and implement are off: add a [reconcile] section to .zarg/config.toml to turn them on" } as const
    const settings = yield* reconcileSettings(extra.reconcile)
    if (!settings.enabled && !opts.force) return { on: false, reason: "plan and implement are off ([reconcile] enabled = false)" } as const
    const missing = ["plan", "implement"].filter((r) => roles[r] === undefined)
    if (missing.length > 0) return { on: false, reason: `plan and implement are off: set ${missing.map((r) => `roles.${r}`).join(" and ")} in .zarg/config.toml` } as const
    const top = yield* gitRun(root, ["rev-parse", "--show-toplevel"])
    if (top.code !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) {
      return { on: false, reason: `plan and implement are off: ${root} is not the top of a git repository` } as const
    }
    return { on: true, settings } as const
  })

/** A failure as text a client may see: its message (never "[object Object]"), with secrets redacted. */
export const reasonOf = (cause: unknown, sensitive: ReadonlyArray<SensitiveValue>) => {
  const text =
    cause instanceof Error
      ? cause.message
      : typeof cause === "object" && cause !== null && typeof (cause as { message?: unknown }).message === "string"
        ? (cause as { message: string }).message
        : typeof cause === "string"
          ? cause
          : JSON.stringify(cause)
  return redact(text, sensitive)
}

export interface PhaseDeps {
  readonly repo: string
  readonly settings: ReconcileSettings
  readonly sensitive: ReadonlyArray<SensitiveValue>
  readonly findings: Findings
  /** An RLM runner over these services (settings, roles, model and decisions already bound). */
  readonly makeRlm: (services: (name: string, scope: Scope) => Bound | undefined, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.Rlm>
  /** Extra services by name (e.g. Decisions). */
  readonly extra?: (name: string) => Bound | undefined
  /** RLM events, tagged with the phase and card they work for. */
  readonly observe?: (phase: string, item: string, e: Rlm.RlmEvent) => void
  readonly withGraphLock?: ReconcileSpec["withGraphLock"]
  readonly stop?: ReconcileSpec["stop"]
  /** A plugin host over a graph store (the pass's worktree graph); plugins run in their own processes. */
  readonly pluginHost: Layer.Layer<PluginHost, unknown, GraphStore>
  /** Cards a graph change affects, asked of the graph plugins. */
  readonly affected: (before: Snapshot.Snapshot, after: Snapshot.Snapshot) => Effect.Effect<{ readonly cards: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> }, unknown>
}

/** The graph as the worktree at `cwd` has it (the pass's graph, not the operator's newer one). */
const withGraph = <A, E>(deps: PhaseDeps, cwd: string, f: (g: { host: PluginHost["Service"]; store: GraphStore["Service"] }) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(Layer.provideMerge(deps.pluginHost, graphLayer(join(cwd, GRAPH))).pipe(Layer.provide(BunServices.layer)))
      return yield* f({ host: Context.get(ctx, PluginHost), store: Context.get(ctx, GraphStore) })
    }),
  )

/** Requirements are never edited downstream: drop anything a phase changed under `.zarg/`. */
const keepRequirements = (cwd: string) =>
  Effect.gen(function* () {
    yield* gitRun(cwd, ["checkout", "-q", "HEAD", "--", ".zarg"])
    yield* gitRun(cwd, ["clean", "-q", "-fd", "--", ".zarg"])
  })

export const planPath = (item: string) => `.zarg/plans/${item}.md`

const planTask = (item: string, card: string) =>
  [
    `Write the implementation plan for card ${item}:`,
    "",
    card,
    "",
    "Read the code you need (Fs.list, Fs.read) and the cards around it (Graph.render, Graph.show).",
    "Finish with `yield* Rlm.done({ value: { plan } })`, where `plan` is Markdown with exactly these sections:",
    "## Approach",
    "## Files   (one line each: - path — what changes)",
    "## Tests   (one line each: - test name — what it proves)",
    "## Depends on   (card ids, or none)",
    "If the card contradicts another card or cannot be implemented as written, finish with `yield* Rlm.done({ value: { blocked: \"<why>\" } })` instead.",
  ].join("\n")

const implementTask = (item: string, card: string, plan: string) =>
  [
    `Implement card ${item} by following its plan.`,
    "",
    card,
    "",
    plan,
    "",
    `Write the code and its tests with Fs.write; tag the implementation and its tests with a \`// @card ${item}\` comment.`,
    "Run Verify.run until it passes. Never edit anything under .zarg/ (requirements and plans are read-only here).",
    "Finish with `yield* Rlm.done({ value: { files, summary } })`.",
    `If the card cannot be implemented as written (it contradicts another card), finish with \`yield* Rlm.done({ value: { files: [], summary: "", blocked: "<why>" } })\`.`,
  ].join("\n")

/** Plan and implement as reconcile phases, backed by RLMs working in each card's worktree. */
export const reconcileSpec = (deps: PhaseDeps): ReconcileSpec => {
  const run = (phase: string, preset: string, item: string, task: string, cwd: string) =>
    withGraph(deps, cwd, ({ host, store }) =>
      Effect.gen(function* () {
        const snapshot = store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message })))
        const services = (name: string, scope: Scope): Bound | undefined => {
          const core = { root: cwd, scope, sensitive: deps.sensitive }
          if (name === "Graph") return graph({ host, snapshot, scope })
          if (name === "Fs") return fs(core)
          if (name === "Fs:read") return fsRead(core)
          if (name === "Sh") return sh(core)
          if (name === "Verify") return verify(core, ["bash", "-c", deps.settings.verify])
          return deps.extra?.(name)
        }
        const rlm = yield* deps.makeRlm(services, (e) => deps.observe?.(phase, item, e))
        const scope: Scope = { graph: { focus: [item], k: 2 }, paths: ["**"], kind: phase }
        return (yield* rlm.exec({ task, preset, scope })).value
      }),
    )
  const card = (cwd: string, item: string) =>
    withGraph(deps, cwd, ({ host, store }) =>
      Effect.gen(function* () {
        const snap = yield* store.snapshot
        const node = snap.nodes.get(item)
        return { text: yield* host.render(new Set([item])), title: String(node?.props.title ?? item), hash: node ? hash(node) : "" }
      }),
    )
  const command = (cwd: string, script: string) => runCommand({ root: cwd, scope: {}, sensitive: deps.sensitive }, ["bash", "-c", script], 1_800_000)

  return {
    repo: deps.repo,
    affected: (before, after) => Effect.map(deps.affected(before, after), (a) => ({ items: a.cards, removed: a.removed })),
    phases: [
      {
        name: "plan",
        setup: false,
        protect: [".zarg/graph"],
        run: (item, cwd) =>
          Effect.gen(function* () {
            const c = yield* card(cwd, item)
            const out = (yield* run("plan", "plan", item, planTask(item, c.text), cwd)) as { plan?: string; blocked?: string }
            if (out.blocked !== undefined || out.plan === undefined) {
              return { ok: false, kind: "unplannable", title: `${item} cannot be planned`, detail: out.blocked ?? "the planner returned no plan" } satisfies ItemOutcome
            }
            const file = join(cwd, planPath(item))
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, `# ${item} ${c.title}\ncard: ${c.hash}\n\n${out.plan.trim()}\n`)
            return { ok: true } satisfies ItemOutcome
          }),
      },
      {
        name: "implement",
        setup: true,
        protect: [".zarg"],
        run: (item, cwd) =>
          Effect.gen(function* () {
            const c = yield* card(cwd, item)
            const planFile = join(cwd, planPath(item))
            const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : "(no plan)"
            const out = (yield* run("implement", "implement-card", item, implementTask(item, c.text, plan), cwd).pipe(Effect.ensuring(Effect.orDie(keepRequirements(cwd))))) as { blocked?: string }
            if (out.blocked !== undefined) return { ok: false, kind: "blocked-card", title: `${item} cannot be implemented as written`, detail: out.blocked } satisfies ItemOutcome
            return { ok: true } satisfies ItemOutcome
          }),
      },
    ],
    ...(deps.settings.setup !== undefined ? { setup: (cwd: string) => Effect.asVoid(Effect.orDie(command(cwd, deps.settings.setup!))) } : {}),
    onRemoved: (items, cwd) => Effect.sync(() => items.forEach((i) => rmSync(join(cwd, planPath(i)), { force: true }))),
    verify: (cwd) =>
      Effect.map(Effect.orDie(command(cwd, deps.settings.verify)), (r) => ({ passed: r.exitCode === 0, output: `${r.stdout}\n${r.stderr}`.trim().slice(-8000) })),
    fix: (cwd, output, attempt) =>
      run(
        "implement",
        "fix",
        `fix-${attempt}`,
        `Verify fails after merging this pass's cards (attempt ${attempt}). Make it pass without changing what the cards require. Never edit anything under .zarg/.\n\n${output}\n\nFinish with \`yield* Rlm.done({ value: "<what you changed>" })\`.`,
        cwd,
      ).pipe(Effect.ensuring(Effect.orDie(keepRequirements(cwd))), Effect.asVoid, Effect.orElseSucceed(() => undefined)),
    resolve: (cwd, files) =>
      run(
        "implement",
        "resolve",
        "resolve",
        `These files have merge conflicts between cards implemented in parallel:\n${files.map((f) => `- ${f}`).join("\n")}\nEdit each so it keeps what both sides meant, with no conflict markers left. Finish with \`yield* Rlm.done({ value: { resolved: true } })\`, or \`{ resolved: false }\` if the two sides cannot both hold.`,
        cwd,
      ).pipe(
        Effect.map((v) => (v as { resolved: boolean }).resolved),
        Effect.orElseSucceed(() => false),
      ),
    findings: deps.findings,
    maxParallel: deps.settings.maxParallel,
    fixAttempts: deps.settings.fixAttempts,
    landRetry: `${deps.settings.landRetryMs} millis`,
    landAttempts: deps.settings.landAttempts,
    message: (items) => `feat: implement ${items.join(", ")}`,
    ...(deps.withGraphLock ? { withGraphLock: deps.withGraphLock } : {}),
    ...(deps.stop ? { stop: deps.stop } : {}),
  }
}
