import { afterAll, describe, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tags, type Tag } from "@zarg/audit"
import { codeOf } from "@zarg/audit/evidence"
import { type Capture, EVIDENCE_DIR, type Evidence, type Media, text } from "@zarg/evidence-capture"
import { clearStale, commit as commitEvidence, type Staged, stage } from "@zarg/evidence-capture/writer"
import { scenarioVersion } from "@zarg/audit/version"
import { Snapshot } from "@zarg/graph/pure"
import { Effect } from "effect"
import { type Term, zarg } from "./term"
import { cli, type Ran, REPO, type World, world } from "./world"

export type Tier = "fast" | "full"
export interface Step {
  readonly w: World
  /** The open terminal (opened by `open`, kept for the journey's later steps), or undefined for CLI-only steps. */
  readonly term: Term | undefined
  readonly open: (args?: ReadonlyArray<string>) => Promise<Term>
  readonly cli: (args: ReadonlyArray<string>) => Promise<Ran>
  /** Attach a text medium now (a CLI transcript, a log excerpt). */
  readonly note: (kind: "buffer" | "log", caption: string, text: string) => Media
  /** Attach any capture (`@zarg/evidence-capture`'s builders, or a capture adapter's) as this step's evidence. */
  readonly attach: (capture: Capture) => Media
}
export type Proves = (scenario: string, fn: (s: Step) => Promise<void>, opts?: { readonly model?: boolean; readonly timeoutMs?: number }) => void

/** The repo whose graph the journeys walk: E2E_EVIDENCE_ROOT, else the zarg repo. */
export const evidenceRoot = () => process.env.E2E_EVIDENCE_ROOT ?? REPO
/** Where evidence is written: E2E_EVIDENCE_OUT (a check that leaves the tree alone, like pre-push), else the repo. */
export const evidenceOut = () => process.env.E2E_EVIDENCE_OUT ?? evidenceRoot()
/** One id per run of the suite: E2E_RUN from the runner, which starts a process per journey; else this process's own. */
export const RUN = process.env.E2E_RUN ?? `e2e-${new Date().toISOString().replace(/:/g, "-")}`

const graphOf = (root: string) => {
  const dir = join(root, ".zarg", "graph", "nodes")
  const nodes = existsSync(dir)
    ? readdirSync(dir).flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(dir, f), "utf8"))]
        } catch (e) {
          // A journey walked over a damaged graph proves nothing: name the file.
          throw new Error(`.zarg/graph/nodes/${f} could not be read: ${e instanceof Error ? e.message : String(e)}`)
        }
      })
    : []
  return Snapshot.make(nodes)
}
const commitOf = (root: string) => Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root }).stdout.toString().trim()

/** A journey of the graph, walked in a fresh world: each `proves` step proves one of its scenarios and writes that scenario's evidence. */
export const journey = (id: string, opts: { readonly tier: Tier; readonly seed?: Readonly<Record<string, string>> }, body: (proves: Proves) => void) => {
  const root = evidenceRoot()
  const graph = graphOf(root)
  const skip = process.env.E2E_TIER === "fast" && opts.tier === "full"
  ;(skip ? describe.skip : describe)(id, () => {
    let w: World | undefined
    let term: Term | undefined
    let failed = false
    let disposed = false
    // A failed journey keeps its world to look into, unless E2E_KEEP_FAILED=0 (the harness tests).
    const dispose = (keep: boolean) => {
      if (disposed || w === undefined) return
      disposed = true
      w.dispose(keep && process.env.E2E_KEEP_FAILED !== "0")
    }
    // A step that ends the process (a crash, an exit) has failed: its world goes the same way.
    process.on("exit", () => dispose(true))
    afterAll(async () => {
      if (term !== undefined) await term.exit().catch(() => undefined)
      dispose(failed)
    })
    let tagged: Promise<ReadonlyArray<Tag>> | undefined
    const proves: Proves = (scenario, fn, o = {}) => {
      const node = graph.nodes.get(scenario)
      if (node?.type !== "gherkin/scenario" || !node.edges.some((e) => e.type === "gherkin/in" && e.to === id)) throw new Error(`${scenario} is not a scenario of ${id}`)
      const timeout = o.timeoutMs ?? (o.model === true ? 300_000 : 120_000)
      let attempts = 0
      test(
        `${scenario} ${String(node.props.title ?? "")}`,
        async () => {
          const evidenceDir = join(evidenceOut(), EVIDENCE_DIR)
          const started = performance.now()
          const deadline = started + timeout
          clearStale(evidenceDir, scenario)
          let staged: Staged | undefined
          let lastNote = ""
          const attempt = async () => {
            // Media is staged and swapped in with the evidence: a run killed mid-step leaves the last evidence whole.
            const mine = stage(evidenceDir, scenario, String(++attempts))
            if (staged !== undefined) rmSync(staged.dir, { recursive: true, force: true })
            staged = mine
            // A world that cannot start fails the step, with its reason as evidence.
            w ??= world(opts.seed)
            const castFrom = term?.cast().trimEnd().split("\n").length ?? 1
            if (term !== undefined) mine.attach(text("the screen before", term.screen()))
            const step: Step = {
              get w() {
                return w!
              },
              get term() {
                return term
              },
              open: async (args) => {
                term = await zarg(w!, args)
                return term
              },
              cli: (args) => cli(w!, args),
              attach: (c) => {
                if (c.kind === "evidence-terminal/text") lastNote = String(Object.values(c.files)[0] ?? "")
                return mine.attach(c)
              },
              note: (kind, caption, body) => {
                lastNote = body
                return mine.attach(text(caption, body, { fold: kind === "log" }))
              },
            }
            try {
              await fn(step)
            } finally {
              if (term !== undefined) {
                mine.attach(text("the screen after", term.screen()))
                const [header, ...events] = term.cast().trimEnd().split("\n")
                mine.attach({ kind: "evidence-terminal/cast", caption: "the step as it played", files: { "step.cast": [header, ...events.slice(Math.max(0, castFrom - 1))].join("\n") + "\n" } })
              }
            }
          }
          let passed = false
          let flaky = false
          let error: unknown
          for (let i = 0; i < (o.model === true ? 2 : 1) && !passed; i++) {
            try {
              const run = attempt()
              // A body past its deadline keeps running: its late end changes nothing.
              run.catch(() => undefined)
              let timer: ReturnType<typeof setTimeout> | undefined
              const late = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${timeout} ms`)), Math.max(0, deadline - performance.now()))
              })
              await Promise.race([run, late]).finally(() => clearTimeout(timer))
              passed = true
              flaky = i > 0
            } catch (e) {
              error = e
            }
          }
          if (!passed) failed = true
          const evidence: Evidence = {
            scenario,
            version: scenarioVersion(graph, scenario)!,
            commit: commitOf(root),
            run: RUN,
            journey: id,
            passed,
            flaky,
            at: new Date().toISOString(),
            ms: Math.round(performance.now() - started),
            media: staged?.media() ?? [],
            failure: passed ? null : { expected: error instanceof Error ? error.message : String(error), saw: term?.screen() ?? lastNote },
            code: codeOf(root, (await (tagged ??= Effect.runPromise(tags(root)))).filter((t) => t.id === scenario).map((t) => t.file)),
          }
          commitEvidence(evidenceDir, staged, evidence)
          if (!passed) throw error
        },
        // Bun's own timeout only backs up the step's deadline, which writes the evidence first.
        timeout + 10_000,
      )
    }
    body(proves)
  })
}
