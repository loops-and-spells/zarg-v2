import { afterAll, beforeAll, describe, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EVIDENCE_DIR, type Evidence, type Media } from "@zarg/audit/evidence"
import { scenarioVersion } from "@zarg/audit/version"
import { Snapshot } from "@zarg/graph/pure"
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
  readonly note: (kind: "buffer" | "log", caption: string, text: string) => void
}
export type Proves = (scenario: string, fn: (s: Step) => Promise<void>, opts?: { readonly model?: boolean; readonly timeoutMs?: number }) => void

/** Where evidence goes: E2E_EVIDENCE_ROOT, else the zarg repo. */
export const evidenceRoot = () => process.env.E2E_EVIDENCE_ROOT ?? REPO
/** One id per run of the suite (one process). */
const RUN = `e2e-${new Date().toISOString().replace(/:/g, "-")}`

const graphOf = (root: string) => {
  const dir = join(root, ".zarg", "graph", "nodes")
  const nodes = existsSync(dir)
    ? readdirSync(dir).flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(dir, f), "utf8"))]
        } catch {
          return []
        }
      })
    : []
  return Snapshot.make(nodes)
}
const commitOf = (root: string) => Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root }).stdout.toString().trim()
const writeAtomic = (file: string, text: string) => {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** A journey of the graph, walked in a fresh world: each `proves` step proves one of its scenarios and writes that scenario's evidence. */
export const journey = (id: string, opts: { readonly tier: Tier; readonly seed?: Readonly<Record<string, string>> }, body: (proves: Proves) => void) => {
  const root = evidenceRoot()
  const graph = graphOf(root)
  const skip = process.env.E2E_TIER === "fast" && opts.tier === "full"
  ;(skip ? describe.skip : describe)(id, () => {
    let w: World | undefined
    let term: Term | undefined
    let failed = false
    beforeAll(() => {
      w = world(opts.seed)
    })
    afterAll(async () => {
      if (term !== undefined) await term.exit().catch(() => undefined)
      w?.dispose(failed)
    })
    const proves: Proves = (scenario, fn, o = {}) => {
      const node = graph.nodes.get(scenario)
      if (node?.type !== "gherkin/scenario" || !node.edges.some((e) => e.type === "gherkin/in" && e.to === id)) throw new Error(`${scenario} is not a scenario of ${id}`)
      const timeout = o.timeoutMs ?? (o.model === true ? 300_000 : 120_000)
      test(
        `${scenario} ${String(node.props.title ?? "")}`,
        async () => {
          const evidenceDir = join(root, EVIDENCE_DIR)
          const mediaDir = join(evidenceDir, "media", scenario)
          const started = performance.now()
          let media: Array<Media> = []
          let lastNote = ""
          const attempt = async () => {
            // Only the latest run is kept.
            rmSync(mediaDir, { recursive: true, force: true })
            mkdirSync(mediaDir, { recursive: true })
            media = []
            const put = (kind: Media["kind"], name: string, caption: string, text: string) => {
              writeFileSync(join(mediaDir, name), text)
              media.push({ kind, path: `media/${scenario}/${name}`, caption })
            }
            let notes = 0
            const castFrom = term?.cast().trimEnd().split("\n").length ?? 1
            if (term !== undefined) put("buffer", "before.txt", "the screen before", term.screen())
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
              note: (kind, caption, text) => {
                lastNote = text
                put(kind, `note-${++notes}.txt`, caption, text)
              },
            }
            try {
              await fn(step)
            } finally {
              if (term !== undefined) {
                put("buffer", "after.txt", "the screen after", term.screen())
                const [header, ...events] = term.cast().trimEnd().split("\n")
                put("cast", "step.cast", "the step as it played", [header, ...events.slice(Math.max(0, castFrom - 1))].join("\n") + "\n")
              }
            }
          }
          let passed = false
          let flaky = false
          let error: unknown
          for (let i = 0; i < (o.model === true ? 2 : 1) && !passed; i++) {
            try {
              await attempt()
              passed = true
              flaky = i > 0
            } catch (e) {
              error = e
            }
          }
          if (!passed) failed = true
          mkdirSync(evidenceDir, { recursive: true })
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
            media,
            failure: passed ? null : { expected: error instanceof Error ? error.message : String(error), saw: term?.screen() ?? lastNote },
          }
          writeAtomic(join(evidenceDir, `${scenario}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
          if (!passed) throw error
        },
        timeout,
      )
    }
    body(proves)
  })
}
