import type { Full } from "@zarg/audit"
import { EVIDENCE_DIR, type Evidence } from "@zarg/audit/evidence"
import { FIRST_PARTY_KINDS, isText, type Json, type KindDecl, resolveKind } from "@zarg/evidence-capture"
import { readFileSync } from "node:fs"
import { join, posix } from "node:path"
import { type FlowStep, flowOf } from "@zarg/audit/flow"
import { scenarioVersion } from "@zarg/audit/version"
import { type Node, Snapshot } from "@zarg/graph/pure"

export type Status = "proven" | "failing" | "stale" | "unproven" | "planned"
/** Red first. */
export const STATUSES: ReadonlyArray<Status> = ["failing", "stale", "unproven", "proven", "planned"]
export type Counts = Readonly<Record<Status, number>>
export type Line = { readonly keyword: "Given" | "And" | "When" | "Then"; readonly text: string; readonly ref?: string }
/** A medium as its renderer gets it: its kind (resolved), its files with their site URLs, the text of text kinds. */
export type MediaView = {
  readonly kind: string
  readonly label: string
  readonly caption: string
  readonly path: string
  readonly present: boolean
  readonly meta?: Json
  readonly files: ReadonlyArray<{ readonly name: string; readonly url: string; readonly text?: string }>
}
type Named = { readonly id: string; readonly name: string }
export type ScenarioPage = {
  readonly id: string
  readonly title: string
  readonly status: Status
  readonly version: string
  readonly by: ReadonlyArray<Named>
  readonly journeys: ReadonlyArray<Named>
  readonly lines: ReadonlyArray<Line>
  readonly code: ReadonlyArray<{ readonly file: string; readonly line: number; readonly url?: string }>
  readonly proof?: { readonly run: string; readonly commit: string; readonly at: string; readonly ms: number; readonly flaky: boolean; readonly failure: Evidence["failure"]; readonly media: ReadonlyArray<MediaView> }
}
export type JourneyPage = { readonly id: string; readonly name: string; readonly outcomes: ReadonlyArray<{ readonly id: string; readonly text: string }>; readonly steps: ReadonlyArray<FlowStep>; readonly apart: ReadonlyArray<string>; readonly counts: Counts }
export type IntentPage = {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly problem: string
  readonly outcomes: ReadonlyArray<{ readonly id: string; readonly text: string; readonly journeys: ReadonlyArray<string> }>
  readonly constraints: ReadonlyArray<{ readonly id: string; readonly text: string; readonly bounds: ReadonlyArray<string> }>
  readonly questions: ReadonlyArray<{ readonly id: string; readonly text: string; readonly answer?: string }>
}
export type Overview = {
  readonly checks: ReadonlyArray<{ readonly name: string; readonly level: "problem" | "warning"; readonly count: number }>
  readonly journeys: ReadonlyArray<{ readonly id: string; readonly name: string; readonly counts: Counts }>
  readonly totals: Counts
  readonly runs: ReadonlyArray<string>
  readonly commits: ReadonlyArray<string>
}
export type SearchEntry = { readonly id: string; readonly kind: "intent" | "outcome" | "journey" | "scenario"; readonly text: string; readonly url: string }
export type Catalog = { readonly overview: Overview; readonly intents: ReadonlyArray<IntentPage>; readonly journeys: ReadonlyArray<JourneyPage>; readonly scenarios: ReadonlyArray<ScenarioPage>; readonly search: ReadonlyArray<SearchEntry> }

const byId = (a: { readonly id: string }, b: { readonly id: string }) => a.id.localeCompare(b.id)
const str = (v: unknown) => (v === undefined ? "" : String(v))

/**
 * A reader of committed evidence media: a medium git does not track (a gitignored video, an untracked buffer) is not
 * there, however it sits on this machine, so every clone builds the same catalog.
 */
export const trackedReader = (root: string): ((path: string) => string | undefined) => {
  const dir = join(root, EVIDENCE_DIR)
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", EVIDENCE_DIR], { cwd: root }).stdout.toString().split("\0")
  const tracked = new Set(listed.filter((f) => f !== "").map((f) => posix.relative(EVIDENCE_DIR, f)))
  return (path) => {
    if (!tracked.has(posix.normalize(path))) return undefined
    try {
      return readFileSync(join(dir, path), "utf8")
    } catch {
      return undefined
    }
  }
}

/** `git@github.com:o/r.git` or `https://github.com/o/r(.git)` → `o/r`; anything else → undefined. */
export const githubRepo = (remote: string): string | undefined => /^(?:git@github\.com:|https:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(remote)?.[1]

const countOf = (statuses: ReadonlyArray<Status>): Counts => Object.fromEntries(STATUSES.map((s) => [s, statuses.filter((x) => x === s).length])) as Counts

/** The page data of a catalog: the graph from intent to scenario, each scenario's proof and its evidence. */
export const catalogOf = (input: {
  readonly snap: Snapshot.Snapshot
  readonly report: Full
  readonly github?: { readonly repo: string; readonly ref: string }
  /** A medium's content (relative to the evidence dir), or undefined when its file is not here. */
  readonly readText: (path: string) => string | undefined
  /** The evidence kinds the running plugins declare (their labels, text or binary); zarg's own are known without. */
  readonly kinds?: Readonly<Record<string, KindDecl>>
}): Catalog => {
  const { snap, report, github } = input
  const declared = input.kinds ?? {}
  const textKind = isText(declared)
  const labelOf = (ref: string) => (declared[ref] ?? FIRST_PARTY_KINDS[ref])?.label ?? ref
  const of = (type: string) => Snapshot.byType(snap, type)
  const out = (n: Node, type: string) => n.edges.filter((e) => e.type === type).map((e) => e.to)
  const named = (id: string): Named => ({ id, name: str(snap.nodes.get(id)?.props.name) || id })
  const textOf = (id: string) => str(snap.nodes.get(id)?.props.text)
  const rows = new Map(report.proofs.map((p) => [p.scenario, p]))
  const status = (id: string): Status => rows.get(id)?.proof ?? "unproven"
  const tags = new Map(report.scenarios.map((s) => [s.id, s.tags]))

  const scenarios = of("gherkin/scenario").map((s): ScenarioPage => {
    const e = rows.get(s.id)?.evidence
    const givens = [...out(s, "gherkin/arrives"), ...out(s, "gherkin/given")]
    const thens = out(s, "gherkin/then")
    const code = [...(tags.get(s.id) ?? [])]
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      .map((t) => ({ file: t.file, line: t.line, ...(github === undefined ? {} : { url: `https://github.com/${github.repo}/blob/${github.ref}/${t.file.split("/").map(encodeURIComponent).join("/")}#L${t.line}` }) }))
    return {
      id: s.id,
      title: str(s.props.title),
      status: status(s.id),
      version: scenarioVersion(snap, s.id) ?? "",
      by: out(s, "gherkin/by").map(named),
      journeys: out(s, "gherkin/in").map(named),
      lines: [
        ...givens.map((ref, i): Line => ({ keyword: i === 0 ? "Given" : "And", text: textOf(ref), ref })),
        { keyword: "When", text: str(s.props.when) },
        ...thens.map((ref, i): Line => ({ keyword: i === 0 ? "Then" : "And", text: textOf(ref), ref })),
      ],
      code,
      ...(e === undefined
        ? {}
        : {
            proof: {
              run: e.run,
              commit: e.commit,
              at: e.at,
              ms: e.ms,
              flaky: e.flaky,
              failure: e.failure,
              media: e.media.map((m): MediaView => {
                const kind = resolveKind(m.kind)
                const listed = (m.meta as { files?: unknown } | undefined)?.files
                const others = Array.isArray(listed) ? listed.filter((f): f is string => typeof f === "string") : []
                const files = [m.path, ...others].map((path) => {
                  const content = input.readText(path)
                  // Text files of any kind go to its renderer too (a trace's trace.json).
                  const text = content !== undefined && (textKind(kind) || /\.(json|txt|cast)$/.test(path))
                  return { name: path.split("/").at(-1)!, url: path, ...(text ? { text: content } : {}), present: content !== undefined }
                })
                return {
                  kind,
                  label: labelOf(kind),
                  caption: m.caption,
                  path: m.path,
                  present: files[0]!.present,
                  ...(m.meta === undefined ? {} : { meta: m.meta }),
                  files: files.map(({ present: _, ...f }) => f),
                }
              }),
            },
          }),
    }
  })

  const journeys = of("gherkin/journey").map((j): JourneyPage => {
    const flow = flowOf(snap, j.id)
    const members = Snapshot.inbound(snap, j.id, "gherkin/in").map((e) => e.from)
    return {
      id: j.id,
      name: str(j.props.name),
      outcomes: out(j, "gherkin/serves").sort().map((id) => ({ id, text: textOf(id) })),
      steps: flow.steps,
      apart: flow.apart,
      counts: countOf(members.map(status)),
    }
  })

  const intents = of("gherkin/intent").map((i): IntentPage => {
    const statements = out(i, "gherkin/has").flatMap((id) => {
      const n = snap.nodes.get(id)
      return n === undefined ? [] : [n]
    }).sort(byId)
    const typed = (type: string) => statements.filter((n) => n.type === type)
    return {
      id: i.id,
      title: str(i.props.title),
      status: str(i.props.status),
      problem: str(i.props.problem),
      outcomes: typed("gherkin/outcome").map((o) => ({ id: o.id, text: textOf(o.id), journeys: Snapshot.inbound(snap, o.id, "gherkin/serves").map((e) => e.from).sort() })),
      constraints: typed("gherkin/constraint").map((k) => ({ id: k.id, text: textOf(k.id), bounds: out(k, "gherkin/bounds").sort() })),
      questions: typed("gherkin/question").map((q) => ({ id: q.id, text: textOf(q.id), ...(q.props.answer === undefined ? {} : { answer: str(q.props.answer) }) })),
    }
  })

  const evidence = report.proofs.flatMap((p) => (p.evidence === undefined ? [] : [p.evidence]))
  const distinct = (xs: ReadonlyArray<string>) => [...new Set(xs)].sort()
  const intentOfOutcome = new Map(intents.flatMap((i) => i.outcomes.map((o) => [o.id, i.id] as const)))
  const search: Array<SearchEntry> = [
    ...intents.map((i): SearchEntry => ({ id: i.id, kind: "intent", text: i.title, url: `intents/${i.id}.html` })),
    ...of("gherkin/outcome").flatMap((o): Array<SearchEntry> => {
      const intent = intentOfOutcome.get(o.id)
      return intent === undefined ? [] : [{ id: o.id, kind: "outcome", text: textOf(o.id), url: `intents/${intent}.html#${o.id}` }]
    }),
    ...journeys.map((j): SearchEntry => ({ id: j.id, kind: "journey", text: j.name, url: `journeys/${j.id}.html` })),
    ...scenarios.map((s): SearchEntry => ({ id: s.id, kind: "scenario", text: s.title, url: `scenarios/${s.id}.html` })),
  ].sort(byId)

  return {
    overview: {
      // Problems first, each level in the report's order.
      checks: [...report.checks].sort((a, b) => (a.level === b.level ? 0 : a.level === "problem" ? -1 : 1)).map((c) => ({ name: c.name, level: c.level, count: c.items.length })),
      journeys: journeys.map((j) => ({ id: j.id, name: j.name, counts: j.counts })),
      totals: countOf(scenarios.map((s) => s.status)),
      runs: distinct(evidence.map((e) => e.run)),
      commits: distinct(evidence.map((e) => e.commit)),
    },
    intents,
    journeys,
    scenarios,
    search,
  }
}
