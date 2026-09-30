import { Effect } from "effect"
import type { Snapshot } from "@zarg/graph/pure"

export const CARD = "gherkin/card"
export type Tag = { readonly id: string; readonly file: string; readonly line: number }
type At = { readonly file: string; readonly line: number }
export type Problem =
  | { readonly kind: "untagged"; readonly card: string; readonly title: string }
  | { readonly kind: "planned-but-tagged"; readonly card: string; readonly title: string; readonly tags: ReadonlyArray<At> }
  | { readonly kind: "orphan"; readonly id: string; readonly file: string; readonly line: number }
export type Report = {
  readonly cards: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: "built" | "planned"; readonly tags: ReadonlyArray<At> }>
  readonly problems: ReadonlyArray<Problem>
}

const MARK = "@" + "card"
/** A tag: the mark, then one or more ids. */
const TAG_RE = new RegExp(`${MARK}((?:\\s+[A-Z]+-\\d+)+)`)
/** Paths never searched: docs quote tags as examples. */
export const IGNORED = ["docs"]

/** `git grep -n` output (`path:line:text`) as tags, one per id a line names. */
export const parseTags = (grep: string): Array<Tag> =>
  grep.split("\n").flatMap((l) => {
    const m = /^(.*?):(\d+):(.*)$/.exec(l)
    const t = m === null ? null : TAG_RE.exec(m[3]!)
    return m === null || t === null ? [] : t[1]!.trim().split(/\s+/).map((id) => ({ id, file: m[1]!, line: Number(m[2]) }))
  })

/** Every card with its status and tags; the problems: untagged, planned-but-tagged, orphan (a tag naming no card). */
export const audit = (snap: Snapshot.Snapshot, tags: ReadonlyArray<Tag>): Report => {
  const cards = [...snap.nodes.values()].filter((n) => n.type === CARD).sort((a, b) => a.id.localeCompare(b.id))
  const at = (id: string) => tags.filter((t) => t.id === id).map((t) => ({ file: t.file, line: t.line }))
  const report = cards.map((c) => ({ id: c.id, title: String(c.props.title ?? ""), status: c.props.planned === true ? ("planned" as const) : ("built" as const), tags: at(c.id) }))
  const known = new Set(cards.map((c) => c.id))
  return {
    cards: report,
    problems: [
      ...report.flatMap((c): Array<Problem> =>
        c.status === "built" && c.tags.length === 0 ? [{ kind: "untagged", card: c.id, title: c.title }] : c.status === "planned" && c.tags.length > 0 ? [{ kind: "planned-but-tagged", card: c.id, title: c.title, tags: c.tags }] : [],
      ),
      ...tags.filter((t) => !known.has(t.id)).map((t): Problem => ({ kind: "orphan", id: t.id, file: t.file, line: t.line })),
    ],
  }
}

/** One line per problem, then the counts. */
export const summary = (r: Report): string => {
  const count = (k: Problem["kind"]) => r.problems.filter((p) => p.kind === k).length
  const built = r.cards.filter((c) => c.status === "built" && c.tags.length > 0).length
  const planned = r.cards.filter((c) => c.status === "planned").length
  return [
    ...r.problems.map((p) =>
      p.kind === "untagged" ? `untagged            ${p.card} ${p.title}` : p.kind === "planned-but-tagged" ? `planned-but-tagged  ${p.card} ${p.tags.map((t) => `${t.file}:${t.line}`).join(", ")}` : `orphan              ${p.id} ${p.file}:${p.line}`,
    ),
    `${built} built · ${planned} planned · ${count("untagged")} untagged · ${count("planned-but-tagged")} planned-but-tagged · ${count("orphan")} orphan`,
  ].join("\n")
}

/** Every tag in the repo at `root`: tracked and untracked files, not ignored ones, not under IGNORED. */
export const tags = (root: string) =>
  Effect.tryPromise({
    try: async () => {
      const p = await Bun.$`git grep -n --untracked -E ${`${MARK}( +[A-Z]+-[0-9]+)+`} -- . ${IGNORED.map((d) => `:!${d}`)}`.cwd(root).quiet().nothrow()
      // git grep exits 1 when nothing matches.
      if (p.exitCode > 1) throw new Error(p.stderr.toString().trim())
      return parseTags(p.stdout.toString())
    },
    catch: (e) => new Error(`git grep in ${root}: ${String(e)}`),
  })
