import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ensureIgnored } from "./worktree"

export type FindingKind = "unplannable" | "blocked-scenario" | "merge-conflict" | "verify-failing" | "landing-blocked" | "pass-error"

/** Something a phase could not project; it reaches the operator through the driver's agenda. */
export interface Finding {
  readonly id: string
  readonly kind: FindingKind
  readonly title: string
  readonly detail: string
  /** The scenarios it concerns. */
  readonly about: ReadonlyArray<string>
  readonly pass: string
  readonly at: string
}

export type NewFinding = Omit<Finding, "id" | "at">

export const findingsPath = (repo: string) => join(repo, ".zarg", "reconcile", "findings.json")

/**
 * Open findings, kept in `.zarg/reconcile/findings.json` (gitignored; survives restarts). A new finding of
 * the same kind about the same scenarios replaces the old one.
 */
export const makeFindings = (repo: string) => {
  const file = findingsPath(repo)
  const read = (): ReadonlyArray<Finding> => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ReadonlyArray<Finding>) : [])
  const write = (all: ReadonlyArray<Finding>) => {
    ensureIgnored(repo)
    writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2))
    renameSync(`${file}.tmp`, file)
  }
  const key = (f: { kind: string; about: ReadonlyArray<string> }) => `${f.kind}:${[...f.about].sort().join(",")}`
  return {
    list: read,
    raise: (f: NewFinding): Finding => {
      const finding: Finding = { ...f, id: `F-${crypto.randomUUID().slice(0, 8)}`, at: new Date().toISOString() }
      write([...read().filter((x) => key(x) !== key(f)), finding])
      return finding
    },
    /** Close findings about no scenario in particular (a pass that could not start or failed outright): a later pass worked. */
    clearGeneral: () => {
      const all = read()
      const kept = all.filter((f) => f.about.length > 0)
      if (kept.length !== all.length) write(kept)
    },
    /** Close every finding about any of these scenarios (they landed, or the driver changed them). */
    clearFor: (scenarios: ReadonlyArray<string>) => {
      const set = new Set(scenarios)
      const all = read()
      const kept = all.filter((f) => !f.about.some((c) => set.has(c)))
      if (kept.length !== all.length) write(kept)
      return all.length - kept.length
    },
  }
}

export type Findings = ReturnType<typeof makeFindings>
