import { Effect } from "effect"
import { Snapshot } from "@zarg/graph/pure"
import { EVIDENCE_DIR, type Evidence, integrity, type Proof, proofOf, readEvidence } from "./evidence"
import { scenarioVersion } from "./version"

export * from "./evidence"
export { scenarioVersion } from "./version"

export const SCENARIO = "gherkin/scenario"
export type Tag = { readonly id: string; readonly file: string; readonly line: number }
type At = { readonly file: string; readonly line: number }
export type Problem =
  | { readonly kind: "untagged"; readonly scenario: string; readonly title: string }
  | { readonly kind: "planned-but-tagged"; readonly scenario: string; readonly title: string; readonly tags: ReadonlyArray<At> }
  | { readonly kind: "orphan"; readonly id: string; readonly file: string; readonly line: number }
export type Report = {
  readonly scenarios: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: "built" | "planned"; readonly tags: ReadonlyArray<At> }>
  readonly problems: ReadonlyArray<Problem>
  /** Intent coverage: warnings until every journey serves an outcome. */
  readonly warnings: ReadonlyArray<Warning>
}
export type Warning = { readonly kind: "uncovered"; readonly outcome: string; readonly text: string } | { readonly kind: "unserving"; readonly journey: string; readonly name: string }

const MARK = "@" + "scenario"
/** A tag: the mark, then one or more ids. */
const TAG_RE = new RegExp(`${MARK}((?:\\s+[A-Z]+-\\d+)+)`, "g")
/** Paths never searched: docs quote tags as examples, evidence quotes them in transcripts. */
export const IGNORED = ["docs", ".zarg/evidence"]

/** `git grep -n` output as tags, one per id a line names: `path\0line\0text` (with -z, so a path may hold `:`), or `path:line:text`. */
export const parseTags = (grep: string): Array<Tag> =>
  grep.split("\n").flatMap((l) => {
    const m = /^([^\0]*)\0(\d+)\0(.*)$/.exec(l) ?? /^(.*?):(\d+):(.*)$/.exec(l)
    if (m === null) return []
    // Every mark on the line (a line may carry the mark twice), each with the ids after it.
    return [...m[3]!.matchAll(TAG_RE)].flatMap((t) => t[1]!.trim().split(/\s+/).map((id) => ({ id, file: m[1]!, line: Number(m[2]) })))
  })

/** Every scenario with its status and tags; the problems: untagged, planned-but-tagged, orphan (a tag naming no scenario). */
export const audit = (snap: Snapshot.Snapshot, tags: ReadonlyArray<Tag>): Report => {
  const scenarios = [...snap.nodes.values()].filter((n) => n.type === SCENARIO).sort((a, b) => a.id.localeCompare(b.id))
  const at = (id: string) => tags.filter((t) => t.id === id).map((t) => ({ file: t.file, line: t.line }))
  const report = scenarios.map((c) => ({ id: c.id, title: String(c.props.title ?? ""), status: c.props.planned === true ? ("planned" as const) : ("built" as const), tags: at(c.id) }))
  const known = new Set(scenarios.map((c) => c.id))
  const of = (type: string) => [...snap.nodes.values()].filter((n) => n.type === type).sort((a, b) => a.id.localeCompare(b.id))
  const outcomes = of("gherkin/outcome")
  const journeys = of("gherkin/journey")
  const served = new Set(journeys.flatMap((j) => j.edges.filter((e) => e.type === "gherkin/serves").map((e) => e.to)))
  const warnings: Array<Warning> = [
    ...outcomes.filter((o) => !served.has(o.id)).map((o): Warning => ({ kind: "uncovered", outcome: o.id, text: String(o.props.text ?? "") })),
    // A journey serves nothing only once there are outcomes to serve.
    ...(outcomes.length === 0 ? [] : journeys.filter((j) => !j.edges.some((e) => e.type === "gherkin/serves")).map((j): Warning => ({ kind: "unserving", journey: j.id, name: String(j.props.name ?? "") }))),
  ]
  return {
    scenarios: report,
    problems: [
      ...report.flatMap((c): Array<Problem> =>
        c.status === "built" && c.tags.length === 0 ? [{ kind: "untagged", scenario: c.id, title: c.title }] : c.status === "planned" && c.tags.length > 0 ? [{ kind: "planned-but-tagged", scenario: c.id, title: c.title, tags: c.tags }] : [],
      ),
      ...tags.filter((t) => !known.has(t.id)).map((t): Problem => ({ kind: "orphan", id: t.id, file: t.file, line: t.line })),
    ],
    warnings,
  }
}

/** One line per problem, then the counts. */
export const summary = (r: Report): string => {
  const count = (k: Problem["kind"]) => r.problems.filter((p) => p.kind === k).length
  const built = r.scenarios.filter((c) => c.status === "built" && c.tags.length > 0).length
  const planned = r.scenarios.filter((c) => c.status === "planned").length
  const warned = (k: Warning["kind"]) => r.warnings.filter((w) => w.kind === k).length
  return [
    ...r.problems.map((p) =>
      p.kind === "untagged" ? `untagged            ${p.scenario} ${p.title}` : p.kind === "planned-but-tagged" ? `planned-but-tagged  ${p.scenario} ${p.tags.map((t) => `${t.file}:${t.line}`).join(", ")}` : `orphan              ${p.id} ${p.file}:${p.line}`,
    ),
    ...r.warnings.map((w) => (w.kind === "uncovered" ? `uncovered           ${w.outcome} ${w.text}` : `unserving           ${w.journey} ${w.name}`)),
    `${built} built · ${planned} planned · ${count("untagged")} untagged · ${count("planned-but-tagged")} planned-but-tagged · ${count("orphan")} orphan${r.warnings.length > 0 ? ` · ${warned("uncovered")} uncovered · ${warned("unserving")} unserving` : ""}`,
  ].join("\n")
}

/** Every tag in the repo at `root`: tracked and untracked files, not ignored ones, not under IGNORED. */
export const tags = (root: string) =>
  Effect.tryPromise({
    try: async () => {
      const p = await Bun.$`git grep -z -n --untracked -E ${`${MARK}([[:space:]]+[A-Z]+-[0-9]+)+`} -- . ${IGNORED.map((d) => `:!${d}`)}`.cwd(root).quiet().nothrow()
      // git grep exits 1 when nothing matches.
      if (p.exitCode > 1) throw new Error(p.stderr.toString().trim())
      return parseTags(p.stdout.toString())
    },
    catch: (e) => new Error(`git grep in ${root}: ${String(e)}`),
  })

export type Level = "problem" | "warning"
export type Item = { readonly id: string; readonly detail: string; readonly media?: ReadonlyArray<string> }
export type CheckName = "structure" | "lints" | "completeness" | "coverage" | "code" | "proof" | "integrity"
export type Check = { readonly name: CheckName; readonly level: Level; readonly items: ReadonlyArray<Item> }
export type ProofRow = { readonly scenario: string; readonly title: string; readonly proof: Proof | "planned"; readonly evidence?: Evidence }
export type Full = Report & { readonly checks: ReadonlyArray<Check>; readonly proofs: ReadonlyArray<ProofRow> }
export type FullInput = {
  readonly snap: Snapshot.Snapshot
  readonly tags: ReadonlyArray<Tag>
  readonly root: string
  /** The store's invalid node files. */
  readonly invalid: ReadonlyArray<{ readonly id: string; readonly detail: string }>
  /** The whole graph's lint findings. */
  readonly findings: ReadonlyArray<{ readonly severity: string; readonly code: string; readonly message: string; readonly about: ReadonlyArray<string> }>
  readonly agenda: ReadonlyArray<{ readonly id: string; readonly title: string; readonly about: ReadonlyArray<string> }>
  /** True when a scenario's tagged code is not what its evidence ran. */
  readonly changedSince: (scenario: string, evidence: Evidence) => boolean
  readonly hasCommit: (sha: string) => boolean
  /** Text or binary by kind (from the running evidence plugins); zarg's own kinds and aliases without it. */
  readonly isText?: (kind: string) => boolean
  /** Binary media is committed (`[e2e] media = "commit"`). */
  readonly commitBinary?: boolean
  /** Completeness, coverage and proof fail the audit too. */
  readonly strict?: boolean
}

/** Lint codes that mean the graph's shape is broken, not its wording. */
const STRUCTURE = new Set(["unknown-type", "unknown-edge", "edge-source", "edge-target", "too-few-edges", "too-many-edges", "duplicate-edge"])
/** Gherkin agenda items coverage reports on its own. */
const COVERAGE_ITEMS = new Set(["gherkin:uncovered", "gherkin:unserving"])
const PROBLEMS_FIRST: ReadonlyArray<CheckName> = ["structure", "lints", "code", "integrity", "completeness", "coverage", "proof"]

/** Everything CI needs to know: the graph's shape and lints, its completeness and intent coverage, code tags, proof by evidence, and the evidence's integrity. */
export const fullAudit = (i: FullInput): Full => {
  const report = audit(i.snap, i.tags)
  const entries = readEvidence(i.root)
  const byScenario = new Map(entries.flatMap((e) => (e.evidence === undefined ? [] : [[e.evidence.scenario, e.evidence] as const])))
  const proofs = report.scenarios.map((s): ProofRow => {
    const evidence = byScenario.get(s.id)
    const proof = s.status === "planned" ? "planned" : proofOf(evidence, scenarioVersion(i.snap, s.id)!, evidence !== undefined && i.changedSince(s.id, evidence))
    return { scenario: s.id, title: s.title, proof, ...(evidence === undefined ? {} : { evidence }) }
  })
  const soft: Level = i.strict === true ? "problem" : "warning"
  // Planned scenarios never count: nor do the states only they reach (a planned scenario's Then is no dead end yet).
  const planned = (id: string) => i.snap.nodes.get(id)?.props.planned === true
  const onlyPlanned = (id: string) => {
    if (planned(id)) return true
    const users = [...i.snap.nodes.values()].filter((n) => n.type === "gherkin/scenario" && n.edges.some((e) => e.to === id))
    return users.length > 0 && users.every((n) => planned(n.id))
  }
  const errors = i.findings.filter((f) => f.severity === "error")
  const finding = (f: (typeof errors)[number]): Item => ({ id: f.about[0] ?? f.code, detail: `${f.code}: ${f.message}` })
  const checks: ReadonlyArray<Check> = [
    {
      name: "structure",
      level: "problem",
      items: [
        ...i.invalid.map((x) => ({ id: x.id, detail: x.detail })),
        ...errors.filter((f) => STRUCTURE.has(f.code)).map(finding),
        ...Snapshot.danglingEdges(i.snap).map((d) => ({ id: d.from, detail: `${d.edge.type} to missing ${d.edge.to}` })),
      ],
    },
    { name: "lints", level: "problem", items: errors.filter((f) => !STRUCTURE.has(f.code)).map(finding) },
    { name: "completeness", level: soft, items: i.agenda.filter((a) => a.id.startsWith("gherkin:") && !COVERAGE_ITEMS.has(a.id) && !(a.about.length > 0 && a.about.every(onlyPlanned))).map((a) => ({ id: a.about[0] ?? a.id, detail: a.title })) },
    { name: "coverage", level: soft, items: report.warnings.map((w) => (w.kind === "uncovered" ? { id: w.outcome, detail: `uncovered: ${w.text}` } : { id: w.journey, detail: `unserving: ${w.name}` })) },
    {
      name: "code",
      level: "problem",
      items: report.problems.map((p) =>
        p.kind === "untagged" ? { id: p.scenario, detail: `untagged: ${p.title}` } : p.kind === "planned-but-tagged" ? { id: p.scenario, detail: `planned-but-tagged: ${p.tags.map((t) => `${t.file}:${t.line}`).join(", ")}` } : { id: p.id, detail: `orphan: ${p.file}:${p.line}` },
      ),
    },
    {
      name: "proof",
      level: soft,
      items: proofs
        .filter((p) => p.proof !== "proven" && p.proof !== "planned")
        .map((p) => ({ id: p.scenario, detail: `${p.proof}: ${p.title}${p.evidence?.failure ? ` (expected ${p.evidence.failure.expected})` : ""}`, ...(p.evidence ? { media: p.evidence.media.map((m) => m.path) } : {}) })),
    },
    { name: "integrity", level: "problem", items: integrity(i.root, entries, new Set(report.scenarios.map((s) => s.id)), i.hasCommit, { ...(i.commitBinary === undefined ? {} : { commitBinary: i.commitBinary }), ...(i.isText === undefined ? {} : { isText: i.isText }) }).map((x) => ({ id: x.file, detail: `${x.kind}: ${x.detail}` })) },
  ]
  return { ...report, checks, proofs }
}

// @scenario S-0113
export const exitCode = (r: Full): 0 | 1 => (r.checks.some((c) => c.level === "problem" && c.items.length > 0) ? 1 : 0)

/** A line per item, problems first, then the counts. */
// @scenario S-0113
export const fullSummary = (r: Full): string => {
  const ordered = PROBLEMS_FIRST.map((n) => r.checks.find((c) => c.name === n)!)
  const counts = (l: Level) => ordered.filter((c) => c.level === l).map((c) => `${c.name} ${c.items.length}`)
  const built = r.proofs.filter((p) => p.proof !== "planned")
  const tail = [
    ...(counts("problem").length > 0 ? [`${counts("problem").join(" · ")} (problems)`] : []),
    ...(counts("warning").length > 0 ? [`${counts("warning").join(" · ")} (warnings)`] : []),
    `${built.filter((p) => p.proof === "proven").length} proven of ${built.length} built, ${r.proofs.length - built.length} planned`,
  ].join(" · ")
  return [...[...ordered].sort((a, b) => (a.level === b.level ? 0 : a.level === "problem" ? -1 : 1)).flatMap((c) => c.items.map((it) => `${c.name.padEnd(13)} ${it.id} ${it.detail}`)), tail].join("\n")
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
/** One test case per scenario: proven passes, planned is skipped, the rest fail with what they expected and their media. */
export const toJunit = (r: Full): string => {
  const failures = r.proofs.filter((p) => p.proof !== "proven" && p.proof !== "planned").length
  const skipped = r.proofs.filter((p) => p.proof === "planned").length
  const cases = r.proofs.map((p) => {
    const open = `<testcase classname="zarg" name="${xml(`${p.scenario} ${p.title}`)}">`
    if (p.proof === "proven") return `${open}</testcase>`
    if (p.proof === "planned") return `${open}<skipped message="planned"/></testcase>`
    const f = p.evidence?.failure
    const body = [f ? `expected: ${f.expected}\nsaw: ${f.saw}` : "", ...(p.evidence?.media ?? []).map((m) => `${m.kind}: ${EVIDENCE_DIR}/${m.path}`)].filter((x) => x !== "").join("\n")
    return `${open}<failure message="${p.proof}">${xml(body)}</failure></testcase>`
  })
  return [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuite name="zarg proof" tests="${r.proofs.length}" failures="${failures}" skipped="${skipped}">`, ...cases, `</testsuite>`, ""].join("\n")
}
