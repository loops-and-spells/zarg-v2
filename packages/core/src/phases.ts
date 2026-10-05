import { stringify } from "@zarg/frontmatter"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Context, Effect, Layer, Schema } from "effect"
import { GraphStore, hash, layer as graphLayer, type Snapshot } from "@zarg/graph"
import type { Bound } from "@zarg/kernel"
import { ConfigError, redact, type SensitiveValue } from "@zarg/model"
import { PluginHost } from "@zarg/plugin/server"
import { type Findings, GRAPH, gitRun, type ItemOutcome, type ReconcileSpec } from "@zarg/reconcile"
import { entitiesService, fs, fsRead, graph, type Rlm, runCommand, type Scope, sh, verify } from "@zarg/rlm"

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

/** /reconcile turned plan and implement on: a project without a [reconcile] section gets one, so they stay on. */
export const rememberReconcile = (root: string) => {
  const file = join(root, ".zarg", "config.toml")
  const text = existsSync(file) ? readFileSync(file, "utf8") : ""
  if (/^\s*\[\s*reconcile\s*\]/m.test(text)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text === "" ? "[reconcile]\n" : `${text.replace(/\n*$/, "\n")}\n[reconcile]\n`)
}

/** The project's own check: a verify task, else a test task (its mise.toml), else its package.json script. */
export const projectCheck = (root: string): string | undefined => {
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : undefined)
  // ponytail: a line match, not a TOML parse; set [reconcile] verify when it guesses wrong.
  const mise = read("mise.toml") ?? read(".mise.toml") ?? ""
  const task = (n: string) => new RegExp(`^\\[tasks\\.${n}\\]|^${n}\\s*=`, "m").test(mise)
  for (const n of ["verify", "test"]) if (task(n)) return `mise run ${n}`
  const scripts = (() => {
    try {
      return (JSON.parse(read("package.json") ?? "{}") as { scripts?: Record<string, unknown> }).scripts ?? {}
    } catch {
      return {}
    }
  })()
  const bun = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))
  for (const n of ["verify", "test"]) if (typeof scripts[n] === "string") return bun ? `bun run ${n}` : n === "test" ? "npm test" : `npm run ${n}`
  return undefined
}

/**
 * Whether plan and implement run for a project: only with a `[reconcile]` section (not `enabled = false`),
 * models for `roles.plan` and `roles.implement`, and the project at the top of a git repository.
 */
export const reconcileGate = (root: string, extra: Readonly<Record<string, unknown>>, roles: Readonly<Record<string, string>>, opts: { readonly force?: boolean } = {}) =>
  Effect.gen(function* () {
    // `force` (the /reconcile command) overrides a missing section and `enabled = false`, nothing else.
    if (extra.reconcile === undefined && !opts.force) return { on: false, reason: "plan and implement are off: /reconcile turns them on (it adds a [reconcile] section to .zarg/config.toml)" } as const
    const settings = yield* reconcileSettings(extra.reconcile)
    if (!settings.enabled && !opts.force) return { on: false, reason: "plan and implement are off ([reconcile] enabled = false)" } as const
    const missing = ["plan", "implement"].filter((r) => roles[r] === undefined)
    if (missing.length > 0) return { on: false, reason: "plan and implement are off: set a default model with /models (or roles.plan and roles.implement)" } as const
    const top = yield* gitRun(root, ["rev-parse", "--show-toplevel"])
    if (top.code !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) {
      return { on: false, reason: `plan and implement are off: ${root} is not the top of a git repository` } as const
    }
    // A pass commits; without an author it would only fail at its end.
    if ((yield* gitRun(root, ["var", "GIT_AUTHOR_IDENT"])).code !== 0) {
      return { on: false, reason: "plan and implement are off: git does not know who commits here: set git config user.name and user.email (--global for every project), then /reconcile" } as const
    }
    // Set in [reconcile]: that command; else the project's own check.
    const own = (extra.reconcile as { verify?: unknown } | undefined)?.verify !== undefined ? settings.verify : projectCheck(root)
    if (own === undefined) {
      return { on: false, reason: "plan and implement are off: nothing says the code is right: add a verify or test task (mise.toml or package.json), or set [reconcile] verify in .zarg/config.toml, then /reconcile" } as const
    }
    return { on: true, settings: { ...settings, verify: own } } as const
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
  /** RLM events, tagged with the phase and scenario they work for. */
  readonly observe?: (phase: string, item: string, e: Rlm.RlmEvent) => void
  readonly withGraphLock?: ReconcileSpec["withGraphLock"]
  readonly onLandWait?: ReconcileSpec["onLandWait"]
  readonly stop?: ReconcileSpec["stop"]
  /** A plugin host over a graph store (the pass's worktree graph); plugins run in their own processes. */
  readonly pluginHost: Layer.Layer<PluginHost, unknown, GraphStore>
  /** Scenarios a graph change affects, asked of the graph plugins. */
  readonly affected: (before: Snapshot.Snapshot, after: Snapshot.Snapshot) => Effect.Effect<{ readonly scenarios: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> }, unknown>
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

const planTask = (item: string, scenario: string, around: string, files: ReadonlyArray<string>) =>
  [
    `Write the implementation plan for scenario ${item}:`,
    "",
    scenario,
    "",
    ...(around.trim() !== "" ? ["The scenarios sharing a state with it:", "", around, ""] : []),
    `The project's files: ${files.length > 0 ? files.join(", ") : "none yet"}.`,
    "",
    "Plan from these: read the code you need (Fs.read); look further in the graph only when they leave something out, never the backlog or feedback.",
    "Finish with `yield* Rlm.done({ value: { plan } })`, where `plan` is Markdown with exactly these sections:",
    "## Approach",
    "## Files   (one line each: - path — what changes)",
    "## Tests   (one line each: - test name — what it proves)",
    "## Depends on   (scenario ids, or none)",
    "If the scenario contradicts another scenario or cannot be implemented as written, finish with `yield* Rlm.done({ value: { blocked: \"<why>\" } })` instead.",
  ].join("\n")

const implementTask = (item: string, scenario: string, plan: string) =>
  [
    `Implement scenario ${item} by following its plan.`,
    "",
    scenario,
    "",
    plan,
    "",
    `Write the code and its tests with Fs.write; tag the implementation and its tests with a \`// @scenario ${item}\` comment, right above the code that does it (the function or test), never at the top of a file: a scenario's tag shows its own code.`,
    "Run Verify.run until it passes. Never edit anything under .zarg/ (requirements and plans are read-only here).",
    "Finish with `yield* Rlm.done({ value: { files, summary } })`.",
    `If the scenario cannot be implemented as written (it contradicts another scenario), finish with \`yield* Rlm.done({ value: { files: [], summary: "", blocked: "<why>" } })\`.`,
  ].join("\n")

/** Plan and implement as reconcile phases, backed by RLMs working in each scenario's worktree. */
export const reconcileSpec = (deps: PhaseDeps): ReconcileSpec => {
  const run = (phase: string, preset: string, item: string, task: string, cwd: string) =>
    withGraph(deps, cwd, ({ host, store }) =>
      Effect.gen(function* () {
        const snapshot = store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message })))
        const services = (name: string, scope: Scope): Bound | undefined => {
          const core = { root: cwd, scope, sensitive: deps.sensitive }
          if (name === "Graph") return graph({ host, snapshot, scope })
          // Reading only: a plan or implement pass never commands another plugin's data.
          if (name === "Entities:read") return entitiesService({ host, snapshot, scope }, { write: false })
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
  const scenario = (cwd: string, item: string) =>
    withGraph(deps, cwd, ({ host, store }) =>
      Effect.gen(function* () {
        const snap = yield* store.snapshot
        const node = snap.nodes.get(item)
        // The scenarios that share a state with it (its Given, context or Thens): what the planner reads first.
        const states = new Set((node?.edges ?? []).map((e) => e.to).filter((id) => snap.nodes.get(id)?.type === "gherkin/state"))
        const siblings = [...snap.nodes.values()].filter((n) => n.id !== item && n.type === "gherkin/scenario" && n.edges.some((e) => states.has(e.to))).map((n) => n.id).slice(0, 8)
        const around = siblings.length === 0 ? "" : yield* host.render(new Set(siblings))
        return { text: yield* host.render(new Set([item])), around, title: String(node?.props.title ?? item), hash: node ? hash(node) : "" }
      }),
    )
  const command = (cwd: string, script: string) => runCommand({ root: cwd, scope: {}, sensitive: deps.sensitive }, ["bash", "-c", script], 1_800_000)

  return {
    repo: deps.repo,
    affected: (before, after) => Effect.map(deps.affected(before, after), (a) => ({ items: a.scenarios, removed: a.removed })),
    phases: [
      {
        name: "plan",
        setup: false,
        protect: [".zarg/graph"],
        run: (item, cwd) =>
          Effect.gen(function* () {
            const c = yield* scenario(cwd, item)
            // ponytail: the first 80 tracked files; a project map when projects are larger.
            const files = (yield* gitRun(cwd, ["ls-files"])).stdout.split("\n").filter((f) => f !== "" && !f.startsWith(".zarg/")).slice(0, 80)
            const out = (yield* run("plan", "plan", item, planTask(item, c.text, c.around, files), cwd)) as { plan?: string; blocked?: string }
            // @scenario S-0057
            if (out.blocked !== undefined || out.plan === undefined) {
              return { ok: false, kind: "unplannable", title: `${item} cannot be planned`, detail: out.blocked ?? "the planner returned no plan" } satisfies ItemOutcome
            }
            const file = join(cwd, planPath(item))
            mkdirSync(dirname(file), { recursive: true })
            // The plan's data in frontmatter: its scenario, the scenario's hash when planned, its title.
            // @scenario S-0056
            writeFileSync(file, stringify({ scenario: item, hash: c.hash, title: c.title }, `# ${item} ${c.title}\n\n${out.plan.trim()}\n`))
            return { ok: true } satisfies ItemOutcome
          }),
      },
      {
        // @scenario S-0021
        name: "implement",
        setup: true,
        protect: [".zarg"],
        run: (item, cwd) =>
          Effect.gen(function* () {
            const c = yield* scenario(cwd, item)
            const planFile = join(cwd, planPath(item))
            const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : "(no plan)"
            const out = (yield* run("implement", "implement-scenario", item, implementTask(item, c.text, plan), cwd).pipe(Effect.ensuring(Effect.orDie(keepRequirements(cwd))))) as { blocked?: string }
            // @scenario S-0024
            if (out.blocked !== undefined) return { ok: false, kind: "blocked-scenario", title: `${item} cannot be implemented as written`, detail: out.blocked } satisfies ItemOutcome
            return { ok: true } satisfies ItemOutcome
          }),
      },
    ],
    ...(deps.settings.setup !== undefined ? { setup: (cwd: string) => Effect.asVoid(Effect.orDie(command(cwd, deps.settings.setup!))) } : {}),
    onRemoved: (items, cwd) => Effect.sync(() => items.forEach((i) => rmSync(join(cwd, planPath(i)), { force: true }))),
    verify: (cwd) =>
      Effect.map(Effect.orDie(command(cwd, deps.settings.verify)), (r) => ({ passed: r.exitCode === 0, output: `${r.stdout}\n${r.stderr}`.trim().slice(-8000) })),
    // @scenario S-0023
    fix: (cwd, output, attempt) =>
      run(
        "implement",
        "fix",
        `fix-${attempt}`,
        `Verify fails after merging this pass's scenarios (attempt ${attempt}). Make it pass without changing what the scenarios require. Never edit anything under .zarg/.\n\n${output}\n\nFinish with \`yield* Rlm.done({ value: "<what you changed>" })\`.`,
        cwd,
      ).pipe(Effect.ensuring(Effect.orDie(keepRequirements(cwd))), Effect.asVoid, Effect.orElseSucceed(() => undefined)),
    // @scenario S-0053
    resolve: (cwd, files) =>
      run(
        "implement",
        "resolve",
        "resolve",
        `These files have merge conflicts between scenarios implemented in parallel:\n${files.map((f) => `- ${f}`).join("\n")}\nEdit each so it keeps what both sides meant, with no conflict markers left. Finish with \`yield* Rlm.done({ value: { resolved: true } })\`, or \`{ resolved: false }\` if the two sides cannot both hold.`,
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
    ...(deps.onLandWait ? { onLandWait: deps.onLandWait } : {}),
  }
}
