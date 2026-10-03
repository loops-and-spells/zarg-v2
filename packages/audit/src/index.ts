import { Effect } from "effect"
import type { Snapshot } from "@zarg/graph/pure"

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
/** Paths never searched: docs quote tags as examples. */
export const IGNORED = ["docs"]

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
