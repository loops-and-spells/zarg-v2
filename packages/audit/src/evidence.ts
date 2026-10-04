import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type MediaKind = "buffer" | "cast" | "log" | "image" | "gif" | "video"
export type Media = { readonly kind: MediaKind; readonly path: string; readonly caption: string; readonly mime?: string }
export type Evidence = {
  readonly scenario: string
  readonly version: string
  readonly commit: string
  readonly run: string
  readonly journey: string
  readonly passed: boolean
  readonly flaky: boolean
  readonly at: string
  readonly ms: number
  readonly media: ReadonlyArray<Media>
  readonly failure: { readonly expected: string; readonly saw: string } | null
  /** The scenario's tagged files at the run, by content (git blob hashes): staleness that survives squash, rebase and shallow clones. */
  readonly code?: Readonly<Record<string, string>>
}
export type Proof = "proven" | "failing" | "stale" | "unproven"
export const EVIDENCE_DIR = ".zarg/evidence"
const ID = /^S-\d+$/
const VERSION = /^[0-9a-f]{12}$/
const BINARY: ReadonlySet<MediaKind> = new Set(["image", "gif", "video"])

const shape = (v: unknown): v is Evidence => {
  const e = v as Evidence
  return typeof e?.scenario === "string" && ID.test(e.scenario) && typeof e.version === "string" && VERSION.test(e.version) && typeof e.commit === "string" && typeof e.passed === "boolean" && Array.isArray(e.media)
}

export type Entry = { readonly file: string; readonly evidence?: Evidence; readonly error?: string }

/** Every evidence file, parsed (a file that does not parse or fit carries its error). */
export const readEvidence = (root: string): ReadonlyArray<Entry> => {
  const dir = join(root, EVIDENCE_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file): Entry => {
      try {
        const v = JSON.parse(readFileSync(join(dir, file), "utf8"))
        return shape(v) ? { file, evidence: v } : { file, error: "not evidence (scenario, version, commit, passed, media)" }
      } catch (e) {
        return { file, error: e instanceof Error ? e.message : String(e) }
      }
    })
}

/** A scenario's proof: a failure stays failing; a pass at another version is unproven; a pass whose code changed since is stale. */
export const proofOf = (e: Evidence | undefined, current: string, changedSince: boolean): Proof =>
  e === undefined || e.version !== current ? "unproven" : !e.passed ? "failing" : changedSince ? "stale" : "proven"

export type Integrity = { readonly kind: "orphan-evidence" | "bad-evidence" | "missing-media" | "unknown-commit"; readonly file: string; readonly detail: string }
/** What makes evidence untrustworthy. Binary media is gitignored unless `commitBinary` (`[e2e] media = "commit"`), so only then must it be here. */
export const integrity = (root: string, entries: ReadonlyArray<Entry>, scenarios: ReadonlySet<string>, hasCommit: (sha: string) => boolean, commitBinary = false): ReadonlyArray<Integrity> =>
  entries.flatMap((x): ReadonlyArray<Integrity> => {
    if (x.evidence === undefined) return [{ kind: "bad-evidence", file: x.file, detail: x.error ?? "unreadable" }]
    const e = x.evidence
    if (x.file !== `${e.scenario}.json`) return [{ kind: "bad-evidence", file: x.file, detail: `holds ${e.scenario}'s evidence` }]
    if (!scenarios.has(e.scenario)) return [{ kind: "orphan-evidence", file: x.file, detail: `${e.scenario} is not in the graph` }]
    return [
      ...e.media
        .filter((m) => (commitBinary || !BINARY.has(m.kind)) && !existsSync(join(root, EVIDENCE_DIR, m.path)))
        .map((m): Integrity => ({ kind: "missing-media", file: x.file, detail: `${m.kind} ${m.path}` })),
      // Evidence with its code by content does not need its commit (a squash or a shallow clone loses it).
      ...(e.code !== undefined || hasCommit(e.commit) ? [] : [{ kind: "unknown-commit" as const, file: x.file, detail: `commit ${e.commit} is not in this repository` }]),
    ]
  })

/** True when any of `files` changed after `commit`: a later commit (renames included) or an edit not yet committed. An unknown commit is integrity's to report. */
export const changedSince = (root: string, files: ReadonlyArray<string>, commit: string): boolean => {
  if (files.length === 0) return false
  const git = (...args: Array<string>) => Bun.spawnSync(["git", ...args], { cwd: root })
  if (git("cat-file", "-e", `${commit}^{commit}`).exitCode !== 0) return false
  const later = git("log", "-1", "--format=%H", `${commit}..HEAD`, "--", ...files)
  if (later.exitCode === 0 && later.stdout.toString().trim() !== "") return true
  return git("diff", "--quiet", "HEAD", "--", ...files).exitCode === 1
}

/** `files` by content (git blob hashes of the working tree). */
export const codeOf = (root: string, files: ReadonlyArray<string>): Readonly<Record<string, string>> => {
  const sorted = [...new Set(files)].sort()
  if (sorted.length === 0) return {}
  const hashes = Bun.spawnSync(["git", "hash-object", "--", ...sorted], { cwd: root }).stdout.toString().trim().split("\n")
  return Object.fromEntries(sorted.map((f, i) => [f, hashes[i] ?? ""]))
}

/** The scenario's tagged code is not what the evidence ran: by content when the evidence recorded it, else by commits since. */
export const codeChanged = (root: string, files: ReadonlyArray<string>, e: Evidence): boolean => {
  if (e.code === undefined) return changedSince(root, files, e.commit)
  const now = codeOf(root, files)
  const then = e.code
  return Object.keys(now).length !== Object.keys(then).length || Object.entries(now).some(([f, h]) => then[f] !== h)
}
