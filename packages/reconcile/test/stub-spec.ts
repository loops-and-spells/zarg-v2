import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { canonical } from "@zarg/graph"
import { engineLayer, makeFindings, Pass, passLayer, type ReconcileSpec, workingGraphTree } from "../src"
import { sh, write } from "./repo"

/** Stub phases: plan writes .zarg/plans/<card>.md; implement writes src/<card>.ts (or what `code` says). */
export const stubSpec = (repo: string, opts: {
  blocked?: ReadonlyArray<string>
  code?: Record<string, { file: string; text: string }>
  brokenFixes?: number
  resolve?: (cwd: string, files: ReadonlyArray<string>) => boolean
  landAttempts?: number
  /** Called when an item is implemented (e.g. to commit on the developer's branch meanwhile). */
  during?: (item: string) => void
  /** Record calls in this file too (for tests that span processes). */
  callLog?: string
  /** Plan writes a partial file for these cards, then fails. */
  planFails?: ReadonlyArray<string>
  /** Implement throws (a defect) for these cards. */
  implementDies?: ReadonlyArray<string>
  /** Verify dies this many times before working. */
  verifyDies?: number
  /** Implement sleeps this long (to overlap passes). */
  slowMs?: number
} = {}): ReconcileSpec & { calls: Array<string> } => {
  const calls: Array<string> = []
  let fixes = 0
  let verifyDeaths = 0
  return {
    calls,
    repo,
    affected: (before, after) => {
      const items = [...after.nodes.values()].filter((n) => n.type === "gherkin/card" && (!before.nodes.has(n.id) || canonical(before.nodes.get(n.id)!) !== canonical(n))).map((n) => n.id)
      const removed = [...before.nodes.keys()].filter((id) => !after.nodes.has(id) && id.startsWith("UX-"))
      return Effect.succeed({ items: items.sort(), removed })
    },
    phases: [
      {
        name: "plan",
        setup: false,
        run: (item, cwd) =>
          Effect.sync(() => {
            calls.push(`plan ${item}`)
            if (opts.callLog) appendFileSync(opts.callLog, `plan ${item}\n`)
            if (opts.planFails?.includes(item)) {
              write(cwd, `.zarg/plans/${item}.md`, "partial\n")
              return { ok: false, kind: "unplannable", title: `${item} cannot be planned`, detail: "stub" } as const
            }
            write(cwd, `.zarg/plans/${item}.md`, `# ${item}\n`)
            return { ok: true } as const
          }),
      },
      {
        name: "implement",
        setup: true,
        run: (item, cwd) =>
          Effect.sync(() => {
            calls.push(`implement ${item}`)
            if (opts.callLog) appendFileSync(opts.callLog, `implement ${item}\n`)
            opts.during?.(item)
            if (opts.implementDies?.includes(item)) throw new Error(`boom in ${item}`)
            if (opts.blocked?.includes(item)) return { ok: false, kind: "blocked-card", title: `${item} contradicts another card`, detail: "stub" } as const
            if (!existsSync(join(cwd, `.zarg/plans/${item}.md`))) return { ok: false, kind: "blocked-card", title: "no plan", detail: "" } as const
            const c = opts.code?.[item] ?? { file: `src/${item}.ts`, text: `// @card ${item}\nexport const ok = true\n` }
            write(cwd, c.file, c.text)
            return { ok: true } as const
          }),
      },
    ],
    onRemoved: (items, cwd) => Effect.sync(() => items.forEach((i) => sh(cwd, `rm -f .zarg/plans/${i}.md src/${i}.ts`))),
    verify: (cwd) =>
      Effect.sync(() => {
        calls.push("verify")
        if (verifyDeaths++ < (opts.verifyDies ?? 0)) throw new Error("verify crashed")
        const src = join(cwd, "src")
        const broken = existsSync(src) && readdirSync(src).some((f) => readFileSync(join(src, f), "utf8").includes("BROKEN"))
        return { passed: !broken, output: broken ? "src contains BROKEN" : "ok" }
      }),
    fix: (cwd) =>
      Effect.sync(() => {
        calls.push("fix")
        if (fixes++ < (opts.brokenFixes ?? 0)) return
        for (const f of readdirSync(join(cwd, "src"))) writeFileSync(join(cwd, "src", f), readFileSync(join(cwd, "src", f), "utf8").replaceAll("BROKEN", "fixed"))
      }),
    resolve: (cwd, files) => Effect.sync(() => opts.resolve?.(cwd, files) ?? false),
    findings: makeFindings(repo),
    maxParallel: 2,
    fixAttempts: 2,
    landRetry: "50 millis",
    landAttempts: opts.landAttempts ?? 10,
    message: (items) => `feat: implement ${items.join(", ")}`,
  }
}

/** Run one pass for the repo's current working graph. */
export const runPass = (spec: ReconcileSpec, db: string, attempt = 0) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const graph = yield* workingGraphTree(spec.repo)
      const base = sh(spec.repo, "git rev-parse HEAD")
      return yield* Pass.execute({ graph, branch: "main", base, attempt })
    }).pipe(Effect.provide(passLayer(spec).pipe(Layer.provideMerge(engineLayer(db))))) as Effect.Effect<typeof Pass.successSchema.Type>,
  )

/** Run passes for the same working graph with different attempts, concurrently, on one engine. */
export const runPasses = (spec: ReconcileSpec, db: string, attempts: ReadonlyArray<number>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const graph = yield* workingGraphTree(spec.repo)
      const base = sh(spec.repo, "git rev-parse HEAD")
      return yield* Effect.all(
        attempts.map((attempt) => Pass.execute({ graph, branch: "main", base, attempt })),
        { concurrency: "unbounded" },
      )
    }).pipe(Effect.provide(passLayer(spec).pipe(Layer.provideMerge(engineLayer(db))))) as unknown as Effect.Effect<ReadonlyArray<typeof Pass.successSchema.Type>>,
  )
