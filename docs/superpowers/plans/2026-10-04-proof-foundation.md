# Proof Foundation (e2e plan 1 of 4): Harness, Evidence, One CI Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** zarg walks its own graph end to end. An e2e harness runs real `zarg` in a brand-new project, and each step that proves a scenario writes committed evidence with media. `zarg audit` becomes the one CI check: structure, lints, completeness, intent coverage, code, proof (proven, failing, stale, unproven) and evidence integrity, with `--json`, `--junit` and exit codes 0/1/2. The first real journey, J-0005 CLI actor, is proven.

**Architecture:**
- **A pure library, `@zarg/audit`:** the scenario content version (moved out of plugin-gherkin so non-plugins can compute it), the evidence model and its statuses, the integrity checks, the report and its output formats.
- **The CLI:** collects what only a plugin host knows (the whole-graph lint, gherkin's agenda) and passes it in.
- **A test-only package, `@zarg/e2e`:**
  - the harness: `world()`, `cli()`, the PTY `zarg()` with `@xterm/headless` and a cast recorder, the preflight;
  - `journey()`/`proves()`, which check the graph, retry model steps once, and write `.zarg/evidence/<S-id>.json` plus media into the zarg repo.

**Tech Stack:** Bun 1.4 (PTY via `Bun.spawn({ terminal })`), Effect 4, `@xterm/headless` 6, bun test, mise tasks, a git hook.

**Spec:** `docs/superpowers/specs/2026-10-04-e2e-suite-design.md`. The plans that follow:
- plan 2: the catalog;
- plan 3: red becomes work;
- plan 4: coverage, graph catch-up and the strict switch.

## Global Constraints

- `mise run build:plugins && mise run verify` passes before every commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- E2e worlds never touch the operator's `~/.config/zarg`, grants, the repo's own `.zarg/graph`, or the router's state. Each world has a temp project, a temp `ZARG_USER_DIR` and a temp `HOME`.
- The suite never starts, restarts, warms or unloads router models. Journeys run one at a time.
- Evidence lives at `.zarg/evidence/<S-id>.json`, with media under `.zarg/evidence/media/<S-id>/`.
  - Text media (`buffer`, `cast`, `log`) is committed.
  - Binary media (`image`, `gif`, `video`) is gitignored unless `[e2e] media = "commit"`.
- The scenario content version is exactly the one feedback pins (today's `scenarioVersion`).
- Audit exit codes: `0` complete and proven, `1` any problem, `2` the audit could not run.
- Until plan 4's strict switch, Completeness, Intent coverage and Proof are **warnings**. Structure, Lints, Code and Evidence integrity are **problems**.

## Review Focus

1. **A step that throws before its first `screen()`** (a world that fails to start). Expected: the evidence file still records `passed: false` with the error and whatever media exists, never a missing file. Task 5 tests it.
2. **Two evidence writes for the same scenario in one run** (a scenario in two journeys). Expected: the last write wins, and the file is never half-written (an atomic write). Task 5 tests it.
3. **A scenario reworded after its evidence.** Expected: `unproven` (the version differs), not `proven`. Task 2 tests it.
4. **Code changed after the evidence's commit.** Expected: `stale`; also when the tagged file is renamed. Task 2 tests it with a fake git log.
5. **`zarg audit` in a repo without `.zarg/evidence`.** Expected: every built scenario `unproven` (a warning), exit 0 when nothing else is wrong. Task 3 tests it.

---

## File Structure

- `packages/audit/src/version.ts` (new, pure): `scenarioVersion(snap, id)`, moved from `plugin-gherkin/src/entities.ts`. It is exported as `@zarg/audit/version`, so the sandboxed gherkin bundle can import it (it has no `Bun.$` or fs).
- `packages/audit/src/evidence.ts` (new): the `Evidence` and `Media` types, `readEvidence(root)`, `proofOf(...)` and `integrity(...)`.
- `packages/audit/src/index.ts`:
  - `Report` gains `checks` (structure, lints, completeness, coverage, code, proof, integrity), each with items and a level (problem or warning);
  - `summary`, `toJson` and `toJunit`.
- `packages/cli/src/commands.ts`: `auditCmd` gathers `host.lint`, gherkin's agenda, the store's invalid files, evidence and git dates; adds `--json` and `--junit`; sets exit codes 0/1/2.
- `packages/e2e/` (new: `package.json`, `mise.toml`, `tsconfig.json`):
  - `src/world.ts`: `world()`, `cli()`;
  - `src/term.ts`: `zarg()`, the PTY session with headless xterm and the cast recorder;
  - `src/preflight.ts`: `preflight(url)`;
  - `src/proof.ts`: `journey()`, `proves()` and the evidence and media writer;
  - `test/harness.test.ts`: the harness's own tests;
  - `journeys/J-0005.test.ts`: the first journey.
- Root `mise.toml`: tasks `e2e`, `e2e:full`, `setup:hooks`.
- `.githooks/pre-push`, `.gitignore` (`e2e-artifacts/`, binary media), and AGENTS.md (the e2e package and Setup's `setup:hooks`).

---

### Task 1: The scenario version as a library function

**Files:**
- Create: `packages/audit/src/version.ts`
- Modify: `packages/audit/package.json` (exports `./version`; dependency `@zarg/entities`)
- Modify: `packages/plugin-gherkin/src/entities.ts` (re-export from `@zarg/audit/version`), `packages/plugin-gherkin/package.json` (dependency `@zarg/audit`)
- Test: `packages/audit/test/version.test.ts`

**Interfaces:**
- Produces `scenarioVersion(snap: Snapshot.Snapshot, id: string): string | undefined` from `@zarg/audit/version`. Its output is byte-identical to today's gherkin function.

- [ ] **Step 1: Write the failing test** (`packages/audit/test/version.test.ts`)

```ts
import { expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { scenarioVersion } from "../src/version"

const n = (id: string, type: string, props: Record<string, unknown>, edges: ReadonlyArray<[string, string]> = []) => ({ id, type, props, edges: edges.map(([t, to]) => ({ type: t, to })) })
const snap = Snapshot.make([
  n("ST-1", "gherkin/state", { text: "a" }), n("ST-2", "gherkin/state", { text: "b" }), n("P-1", "gherkin/persona", { name: "Op", kind: "human", text: "x" }),
  n("S-1", "gherkin/scenario", { title: "t", when: "w", planned: true }, [["gherkin/arrives", "ST-1"], ["gherkin/then", "ST-2"], ["gherkin/by", "P-1"], ["gherkin/in", "J-1"]]),
] as never)

test("the version hashes what a tester reads (not planned, not the journeys); a reworded state changes it", () => {
  const v = scenarioVersion(snap, "S-1")!
  expect(v).toMatch(/^[0-9a-f]{12}$/)
  const unplanned = Snapshot.make([...snap.nodes.values()].map((x) => (x.id === "S-1" ? { ...x, props: { title: "t", when: "w" } } : x)) as never)
  expect(scenarioVersion(unplanned, "S-1")).toBe(v)
  const reworded = Snapshot.make([...snap.nodes.values()].map((x) => (x.id === "ST-2" ? { ...x, props: { text: "c" } } : x)) as never)
  expect(scenarioVersion(reworded, "S-1")).not.toBe(v)
  expect(scenarioVersion(snap, "ST-1")).toBeUndefined()
})
```

- [ ] **Step 2: Run it and watch it fail**: `cd packages/audit && mise x -- bun test test/version.test.ts`. Expected: FAIL, because `../src/version` is not found.
- [ ] **Step 3: Implement.** Move the `reads` and `scenarioVersion` bodies from `packages/plugin-gherkin/src/entities.ts` into `packages/audit/src/version.ts`. Keep the code, comments and `versionOf` import (`@zarg/entities`), and the `gherkin/scenario` type check as the literal string. In `audit/package.json`:
  - `"exports": { ".": "./src/index.ts", "./version": "./src/version.ts" }`;
  - add `"@zarg/entities": "workspace:*"`.

  In `plugin-gherkin/src/entities.ts`, replace the moved code with `export { scenarioVersion } from "@zarg/audit/version"` and keep `scenarioLabel`. Add `"@zarg/audit": "workspace:*"` to plugin-gherkin's dependencies, then `mise x -- bun install`.
- [ ] **Step 4: Run them and watch them pass**: `cd packages/audit && mise x -- bun test`, then `cd ../plugin-gherkin && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`. Expected: PASS. Also check that the gherkin bundle still builds with `mise run build:plugins`; it must not pull `Bun.$` from `@zarg/audit`'s index.
- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/audit packages/plugin-gherkin bun.lock packages/plugin/src/server/first-party-hashes.ts && git commit -m "refactor: the scenario version is a library function (@zarg/audit/version)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Evidence, its statuses and its integrity

**Files:**
- Create: `packages/audit/src/evidence.ts`
- Test: `packages/audit/test/evidence.test.ts`

**Interfaces:**
- Produces:
```ts
export type MediaKind = "buffer" | "cast" | "log" | "image" | "gif" | "video"
export type Media = { readonly kind: MediaKind; readonly path: string; readonly caption: string; readonly mime?: string }
export type Evidence = { readonly scenario: string; readonly version: string; readonly commit: string; readonly run: string; readonly journey: string; readonly passed: boolean; readonly flaky: boolean; readonly at: string; readonly ms: number; readonly media: ReadonlyArray<Media>; readonly failure: { readonly expected: string; readonly saw: string } | null }
export type Proof = "proven" | "failing" | "stale" | "unproven"
export const EVIDENCE_DIR = ".zarg/evidence"
export const readEvidence: (root: string) => ReadonlyArray<{ readonly file: string; readonly evidence?: Evidence; readonly error?: string }>
/** current: the scenario's version now; changedSince: true when its tagged files have a commit newer than the evidence's commit. */
export const proofOf: (e: Evidence | undefined, current: string, changedSince: boolean) => Proof
export type Integrity = { readonly kind: "orphan-evidence" | "bad-evidence" | "missing-media" | "unknown-commit"; readonly file: string; readonly detail: string }
export const integrity: (root: string, entries: ReturnType<typeof readEvidence>, scenarios: ReadonlySet<string>, hasCommit: (sha: string) => boolean) => ReadonlyArray<Integrity>
```

- [ ] **Step 1: Write the failing tests** (`packages/audit/test/evidence.test.ts`)

```ts
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Evidence, integrity, proofOf, readEvidence } from "../src/evidence"

const ev = (over: Partial<Evidence> = {}): Evidence => ({ scenario: "S-0001", version: "aaaaaaaaaaaa", commit: "abc1234", run: "e2e-1", journey: "J-0005", passed: true, flaky: false, at: "2026-10-04T00:00:00Z", ms: 10, media: [], failure: null, ...over })

test("proofOf: passed at this version is proven; failed is failing; another version is unproven; code changed after is stale", () => {
  expect(proofOf(ev(), "aaaaaaaaaaaa", false)).toBe("proven")
  expect(proofOf(ev({ passed: false }), "aaaaaaaaaaaa", false)).toBe("failing")
  expect(proofOf(ev(), "bbbbbbbbbbbb", false)).toBe("unproven")
  expect(proofOf(undefined, "aaaaaaaaaaaa", false)).toBe("unproven")
  expect(proofOf(ev(), "aaaaaaaaaaaa", true)).toBe("stale")
  // A failure stays failing even when code changed since: the next run decides.
  expect(proofOf(ev({ passed: false }), "aaaaaaaaaaaa", true)).toBe("failing")
})

test("readEvidence and integrity: orphans, bad files, missing media, unknown commits", () => {
  const root = mkdtempSync(join(tmpdir(), "zt-ev-"))
  const dir = join(root, ".zarg", "evidence")
  mkdirSync(join(dir, "media", "S-0001"), { recursive: true })
  writeFileSync(join(dir, "media", "S-0001", "after.txt"), "frame")
  writeFileSync(join(dir, "S-0001.json"), JSON.stringify(ev({ media: [{ kind: "buffer", path: "media/S-0001/after.txt", caption: "c" }, { kind: "cast", path: "media/S-0001/gone.cast", caption: "c" }] })))
  writeFileSync(join(dir, "S-0099.json"), JSON.stringify(ev({ scenario: "S-0099" })))
  writeFileSync(join(dir, "S-0002.json"), "{ not json")
  writeFileSync(join(dir, "S-0003.json"), JSON.stringify(ev({ scenario: "S-0003", commit: "deadbee" })))
  const entries = readEvidence(root)
  expect(entries.map((e) => [e.file, e.evidence?.scenario ?? null, e.error === undefined]).sort()).toEqual([["S-0001.json", "S-0001", true], ["S-0002.json", null, false], ["S-0003.json", "S-0003", true], ["S-0099.json", "S-0099", true]])
  const found = integrity(root, entries, new Set(["S-0001", "S-0002", "S-0003"]), (sha) => sha === "abc1234")
  expect(found.map((f) => [f.kind, f.file]).sort()).toEqual([["bad-evidence", "S-0002.json"], ["missing-media", "S-0001.json"], ["orphan-evidence", "S-0099.json"], ["unknown-commit", "S-0003.json"]])
  expect(readEvidence(mkdtempSync(join(tmpdir(), "zt-ev-none-")))).toEqual([])
})
```

- [ ] **Step 2: Run them and watch them fail**: `cd packages/audit && mise x -- bun test test/evidence.test.ts`. Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement** (`evidence.ts`)

```ts
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
}
export type Proof = "proven" | "failing" | "stale" | "unproven"
export const EVIDENCE_DIR = ".zarg/evidence"
const ID = /^S-\d+$/
const VERSION = /^[0-9a-f]{12}$/

const shape = (v: unknown): v is Evidence => {
  const e = v as Evidence
  return typeof e?.scenario === "string" && ID.test(e.scenario) && typeof e.version === "string" && VERSION.test(e.version) && typeof e.commit === "string" && typeof e.passed === "boolean" && Array.isArray(e.media)
}

/** Every evidence file, parsed (a file that does not parse or fit carries its error). */
export const readEvidence = (root: string) => {
  const dir = join(root, EVIDENCE_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file): { readonly file: string; readonly evidence?: Evidence; readonly error?: string } => {
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
export const integrity = (root: string, entries: ReturnType<typeof readEvidence>, scenarios: ReadonlySet<string>, hasCommit: (sha: string) => boolean): ReadonlyArray<Integrity> =>
  entries.flatMap((x): ReadonlyArray<Integrity> => {
    if (x.evidence === undefined) return [{ kind: "bad-evidence", file: x.file, detail: x.error ?? "unreadable" }]
    const e = x.evidence
    if (!scenarios.has(e.scenario)) return [{ kind: "orphan-evidence", file: x.file, detail: `${e.scenario} is not in the graph` }]
    return [
      ...e.media.filter((m) => !existsSync(join(root, EVIDENCE_DIR, m.path))).map((m): Integrity => ({ kind: "missing-media", file: x.file, detail: `${m.kind} ${m.path}` })),
      ...(hasCommit(e.commit) ? [] : [{ kind: "unknown-commit" as const, file: x.file, detail: `commit ${e.commit} is not in this repository` }]),
    ]
  })
```

  A binary medium that isn't committed (gitignored) is missing on another machine. That's expected, so `missing-media` skips `image`, `gif` and `video` unless `[e2e] media = "commit"`. The CLI passes that setting (Task 3). Here, the test covers text kinds only.

- [ ] **Step 4: Run them and watch them pass**: `cd packages/audit && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
mise run verify && git add packages/audit && git commit -m "feat(audit): evidence: proven, failing, stale, unproven; integrity checks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `zarg audit`, the one CI check

**Files:**
- Modify: `packages/audit/src/index.ts` (the report's checks, `summary`, `toJson`, `toJunit`)
- Modify: `packages/cli/src/commands.ts` (`auditCmd`: inputs, flags, exit codes)
- Test: `packages/audit/test/audit.test.ts` (append), `packages/cli/test/cli.test.ts` (append: exit codes in a temp repo)

**Interfaces:**
- Produces, in `@zarg/audit`:
```ts
export type Level = "problem" | "warning"
export type Item = { readonly id: string; readonly detail: string; readonly media?: ReadonlyArray<string> }
export type Check = { readonly name: "structure" | "lints" | "completeness" | "coverage" | "code" | "proof" | "integrity"; readonly level: Level; readonly items: ReadonlyArray<Item> }
export type Full = Report & { readonly checks: ReadonlyArray<Check>; readonly proofs: ReadonlyArray<{ readonly scenario: string; readonly title: string; readonly proof: Proof | "planned"; readonly evidence?: Evidence }> }
export const fullAudit: (input: {
  readonly snap: Snapshot.Snapshot; readonly tags: ReadonlyArray<Tag>; readonly root: string
  readonly invalid: ReadonlyArray<{ readonly id: string; readonly detail: string }>    // the store's invalid files
  readonly findings: ReadonlyArray<{ readonly severity: string; readonly code: string; readonly message: string; readonly about: ReadonlyArray<string> }>  // host.lint
  readonly agenda: ReadonlyArray<{ readonly id: string; readonly title: string; readonly about: ReadonlyArray<string> }>    // host.agenda()
  readonly changedSince: (scenario: string, commit: string) => boolean
  readonly hasCommit: (sha: string) => boolean
  readonly strict?: boolean
}) => Full
export const summary: (r: Full) => string
export const toJson: (r: Full) => unknown
export const toJunit: (r: Full) => string
export const exitCode: (r: Full) => 0 | 1
```
- How each check is built:
  - **structure:** `invalid` (an invalid node file), plus `findings` with severity `error` and a code in `["unknown-type", "unknown-edge", "edge-source", "edge-target", "too-few-edges", "too-many-edges", "duplicate-edge"]`, plus dangling edges (`Snapshot.danglingEdges`).
  - **lints:** the other `findings` with severity `error`.
  - **completeness:** `agenda` items whose id starts with `gherkin:dead-end:`, `gherkin:unreached:`, `gherkin:who-does`, `gherkin:no-outcome:`, `gherkin:question:`, or that is `gherkin:no-personas`.
  - **coverage:** today's `warnings` (uncovered, unserving).
  - **code:** today's `problems` (untagged, planned-but-tagged, orphan).
  - **proof:** built scenarios that aren't `proven`.
  - **integrity:** `integrity(...)`.
- Levels: structure, lints, code and integrity are always `problem`. Completeness, coverage and proof are `warning` until `strict` (plan 4 sets it).
- `exitCode`: 1 when any `problem` check has items, else 0.

- [ ] **Step 1: Write the failing tests** (append to `packages/audit/test/audit.test.ts`)

```ts
import { mkdirSync as mk, mkdtempSync as mkt, writeFileSync as wf } from "node:fs"
import { fullAudit, toJunit, exitCode, summary as sum } from "../src/index"
import { scenarioVersion } from "../src/version"

describe("the full audit", () => {
  const base = { tags: [], invalid: [], findings: [], agenda: [], changedSince: () => false, hasCommit: () => true }
  const root = () => mkt(join(tmpdir(), "zt-full-"))
  const graph = Snapshot.make([
    { id: "ST-1", type: "gherkin/state", props: { text: "a" }, edges: [] },
    { id: "S-1", type: "gherkin/scenario", props: { title: "one", when: "w" }, edges: [{ type: "gherkin/arrives", to: "ST-1" }, { type: "gherkin/then", to: "ST-1" }] },
    { id: "S-2", type: "gherkin/scenario", props: { title: "two", when: "w", planned: true }, edges: [{ type: "gherkin/arrives", to: "ST-1" }, { type: "gherkin/then", to: "ST-1" }] },
  ] as never)
  test("a repo without evidence: built scenarios unproven (a warning), planned ones planned; exit 0 when nothing else is wrong", () => {
    const r = fullAudit({ ...base, snap: graph, root: root(), tags: [{ id: "S-1", file: "a.ts", line: 1 }] })
    expect(r.proofs.map((p) => [p.scenario, p.proof])).toEqual([["S-1", "unproven"], ["S-2", "planned"]])
    expect(r.checks.find((c) => c.name === "proof")).toMatchObject({ level: "warning", items: [{ id: "S-1" }] })
    expect(exitCode(r)).toBe(0)
  })
  test("proven, stale and failing come from the evidence at the scenario's current version", () => {
    const dir = root()
    mk(join(dir, ".zarg", "evidence"), { recursive: true })
    const v = scenarioVersion(graph, "S-1")!
    wf(join(dir, ".zarg", "evidence", "S-1.json"), JSON.stringify({ scenario: "S-1", version: v, commit: "c1", run: "r", journey: "J-1", passed: true, flaky: false, at: "t", ms: 1, media: [], failure: null }))
    const proven = fullAudit({ ...base, snap: graph, root: dir, tags: [{ id: "S-1", file: "a.ts", line: 1 }] })
    expect(proven.proofs[0]!.proof).toBe("proven")
    const stale = fullAudit({ ...base, snap: graph, root: dir, tags: [{ id: "S-1", file: "a.ts", line: 1 }], changedSince: () => true })
    expect(stale.proofs[0]!.proof).toBe("stale")
  })
  test("structure, lints and integrity are problems (exit 1); completeness and coverage are warnings until strict", () => {
    const r = fullAudit({
      ...base,
      snap: graph,
      root: root(),
      tags: [{ id: "S-1", file: "a.ts", line: 1 }],
      invalid: [{ id: "S-9", detail: "S-9.json: not JSON" }],
      findings: [{ severity: "error", code: "conditional", message: "S-1: contains if", about: ["S-1"] }, { severity: "warn", code: "and-chaining", message: "x", about: [] }],
      agenda: [{ id: "gherkin:dead-end:ST-1", title: "What next?", about: ["ST-1"] }, { id: "plugin-grant:backlog", title: "grant", about: [] }],
    })
    expect(r.checks.map((c) => [c.name, c.level, c.items.length])).toEqual([
      ["structure", "problem", 1], ["lints", "problem", 1], ["completeness", "warning", 1], ["coverage", "warning", 0], ["code", "problem", 0], ["proof", "warning", 1], ["integrity", "problem", 0],
    ])
    expect(exitCode(r)).toBe(1)
    expect(fullAudit({ ...base, snap: graph, root: root(), tags: [{ id: "S-1", file: "a.ts", line: 1 }], strict: true }).checks.find((c) => c.name === "proof")!.level).toBe("problem")
  })
  test("junit: one test case per scenario; proven passes, the rest fail with their media; planned is skipped", () => {
    const xml = toJunit(fullAudit({ ...base, snap: graph, root: root(), tags: [{ id: "S-1", file: "a.ts", line: 1 }] }))
    expect(xml).toContain('<testsuite name="zarg proof" tests="2" failures="1" skipped="1">')
    expect(xml).toContain('<testcase classname="zarg" name="S-1 one"><failure message="unproven"')
    expect(xml).toContain('<testcase classname="zarg" name="S-2 two"><skipped message="planned"/></testcase>')
  })
  test("the summary groups by check, problems first, with a count line", () => {
    const r = fullAudit({ ...base, snap: graph, root: root(), tags: [{ id: "S-1", file: "a.ts", line: 1 }] })
    expect(sum(r).split("\n").at(-1)).toBe("structure 0 · lints 0 · code 0 · integrity 0 (problems) · completeness 0 · coverage 0 · proof 1 (warnings) · 0 proven of 1 built, 1 planned")
  })
})
```
Keep the existing `audit` and `summary` exports working. `zarg audit --scenario` and the old tests use them.

- [ ] **Step 2: Run them and watch them fail**: `cd packages/audit && mise x -- bun test`. Expected: FAIL, because `fullAudit` is not exported.
- [ ] **Step 3: Implement `fullAudit`, `summary`, `toJson`, `toJunit` and `exitCode`** in `packages/audit/src/index.ts`:
  - `fullAudit`:
    1. call the existing `audit(snap, tags)` for code and coverage;
    2. call `readEvidence(root)`;
    3. for each scenario, compute `proof` from `proofOf(evidence by scenario, scenarioVersion(snap, id)!, changedSince(id, evidence.commit))`, or `"planned"` when it is planned;
    4. build the seven checks as described above.
  - `toJunit`: escape `&`, `<`, `>` and `"`. One `<testcase classname="zarg" name="<id> <title>">` per scenario:
    - `proven`: no child;
    - `failing`, `stale` or `unproven`: a `<failure message="<proof>">`, its text the failure (expected and saw) and the media paths;
    - `planned`: `<skipped message="planned"/>`.

    The root is `<testsuite name="zarg proof" tests="N" failures="F" skipped="K">`, preceded by `<?xml version="1.0" encoding="UTF-8"?>`.
  - `summary`: for each check with items, a line per item (`<check>  <id>  <detail>`), problems first, then the count line in the test's format.
  - `toJson`: `{ checks, proofs }`.
- [ ] **Step 4: Wire the CLI** (`auditCmd` in `packages/cli/src/commands.ts`):
  - **Flags:** `json: Flag.Boolean("json")`, `junit: Flag.String("junit").pipe(Flag.optional)`.
  - **Inputs:**
    - `invalid` from `(yield* GraphStore.use((s) => s.load)).problems`, mapped to `{ id: basename(p.file, ".json"), detail: p.message }`. Check the `InvalidNode` fields with `grep -n "class InvalidNode" -A6 packages/graph/src/errors.ts`.
    - `findings` from `PluginHost.use((h) => h.lint)`.
    - `agenda` from `PluginHost.use((h) => h.agenda())`.
    - `changedSince(scenario, commit)`: the files tagged with that scenario. For `git log -1 --format=%H <commit>..HEAD -- <files>`, true when it prints a hash; false when there are no tagged files or the commit is unknown (integrity reports that).
    - `hasCommit(sha)`: `git cat-file -e <sha>^{commit}` exits 0.
    - `strict`: false. Plan 4 turns it on.
  - **Output:** `--json` prints `toJson`; `--junit <file>` also writes `toJunit` there. The default prints the summary when `--summary` is set, and otherwise the JSON report (today's behaviour).
  - **Exit codes:** `process.exitCode = exitCode(report)`. Wrap the whole command so an unexpected failure (an unreadable graph, git missing) prints the reason to stderr and sets `process.exitCode = 2`.
- [ ] **Step 5: CLI test** (append to `packages/cli/test/cli.test.ts`, in the style of its `zarg(...)` helper): in the test's temp repo,
  - `zarg audit --json` exits 0 and its `checks` include a `proof` warning;
  - after writing a scenario file that can't be parsed into `.zarg/graph/nodes/S-0099.json`, `zarg audit` exits 1 with `structure` items;
  - with `--junit <tmp>/j.xml`, the file starts with `<?xml`.
- [ ] **Step 6: Run them and watch them pass**: `cd packages/audit && mise x -- bun test`, then `cd ../cli && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`. Also run `mise run -q zarg -- audit --summary` in the repo and check the last line shows the counts and that it exits 0 today (proof is a warning).
- [ ] **Step 7: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/audit packages/cli && git commit -m "feat(audit): zarg audit is the one CI check: structure, lints, completeness, coverage, code, proof, integrity; --json, --junit, exit 0/1/2

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The harness: a world, the CLI, the real terminal, the preflight

**Files:**
- Create: `packages/e2e/package.json`, `packages/e2e/mise.toml`, `packages/e2e/tsconfig.json`
- Create: `packages/e2e/src/world.ts`, `packages/e2e/src/term.ts`, `packages/e2e/src/preflight.ts`, `packages/e2e/src/index.ts`
- Test: `packages/e2e/test/harness.test.ts`

**Interfaces:**
- Produces:
```ts
export const REPO: string                       // the zarg checkout (two levels up from packages/e2e)
export interface World { readonly project: string; readonly userDir: string; readonly home: string; readonly env: Readonly<Record<string, string>>; readonly dispose: (keep: boolean) => void }
export const world: (seed?: Readonly<Record<string, string>>) => World   // seed: relative path → file content, committed in the first commit
export const cli: (w: World, args: ReadonlyArray<string>) => Promise<{ readonly code: number; readonly out: string; readonly err: string; readonly json: unknown }>
export interface Term {
  readonly screen: () => string
  readonly waitFor: (what: string | RegExp, timeoutMs?: number) => Promise<string>
  readonly type: (text: string) => void
  readonly press: (key: string) => void
  readonly paste: (text: string) => void
  readonly exit: () => Promise<number>
  /** The session so far as an asciicast v2 document. */
  readonly cast: () => string
}
export const zarg: (w: World, args?: ReadonlyArray<string>) => Promise<Term>
export const preflight: (url: string, models: ReadonlyArray<string>) => Promise<void>   // rejects with the spec's message
```
- `world()`:
  - a temp project with `git init -q`, the seed files, `git add -A` and `git commit -qm init` (with author and committer env set);
  - a temp user dir and a temp home;
  - `env`: `PATH` (from `process.env`), `HOME`, `ZARG_USER_DIR`, `TERM=xterm-256color`, `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` (`e2e`, `e2e@zarg.invalid`). Nothing else.
- `cli()`: runs `[process.execPath, REPO/packages/cli/src/main.ts, ...args]` with `cwd: w.project, env: w.env`; `json` is the parsed stdout when it parses.
- `zarg()`:
  - `Bun.spawn([...], { cwd, env, terminal: { cols: 120, rows: 40, data } })`;
  - each chunk is written to an `@xterm/headless` `Terminal({ cols: 120, rows: 40, allowProposedApi: true })` and appended to the cast's events as `[seconds, "o", text]`;
  - `screen()` reads `term.buffer.active` rows `0..39` with `translateToString(true)`, joined by `\n`;
  - `waitFor` polls `screen()` every 50 ms;
  - `press` maps names to sequences: `enter` `\r`, `esc` `\x1b`, `tab` `\t`, `up` `\x1b[A`, `down` `\x1b[B`, `left` `\x1b[D`, `right` `\x1b[C`, `space` ` `, `backspace` `\x7f`, `ctrl+<c>` the control char, `alt+<c>` `\x1b<c>`, and single characters as themselves;
  - `paste` writes `\x1b[200~${text}\x1b[201~`;
  - `exit` presses `ctrl+d` and awaits `proc.exited`, killing after 10 s.

- [ ] **Step 1: Create the package**

```bash
mkdir -p packages/e2e/src packages/e2e/test packages/e2e/journeys
cp packages/agent-triage/tsconfig.json packages/e2e/tsconfig.json
cat > packages/e2e/package.json <<'EOF'
{
  "name": "@zarg/e2e",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@zarg/audit": "workspace:*", "@zarg/graph": "workspace:*" }
}
EOF
cd packages/e2e && mise x -- bun add -d @xterm/headless@^6 && cd ../..
cat > packages/e2e/mise.toml <<'EOF'
[tasks.typecheck]
run = "mise x -- bunx tsc"

[tasks.test]
description = "The harness's own tests (no models, no router)"
run = "mise x -- bun test test"
EOF
```
  Make `tsconfig.json`'s `include` cover `["src", "test", "journeys"]`. The package's `test` task runs only `test/`. Journeys run through the root `e2e` tasks (Task 7), never inside `verify`.

- [ ] **Step 2: Write the failing tests** (`packages/e2e/test/harness.test.ts`)

```ts
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli, preflight, world, zarg } from "../src"

test("a world is a fresh git project with its own user dir and home; disposed after a pass", async () => {
  const w = world({ "README.md": "hi\n" })
  expect(existsSync(join(w.project, ".git"))).toBe(true)
  expect(readFileSync(join(w.project, "README.md"), "utf8")).toBe("hi\n")
  expect(w.env.ZARG_USER_DIR).toBe(w.userDir)
  expect(w.env.HOME).toBe(w.home)
  expect(Object.keys(w.env).sort()).toEqual(["GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_NAME", "HOME", "PATH", "TERM", "ZARG_USER_DIR"])
  w.dispose(false)
  expect(existsSync(w.project)).toBe(false)
})

test("cli runs zarg in the world and parses its JSON", async () => {
  const w = world()
  const r = await cli(w, ["agenda"])
  expect(r.code).toBe(0)
  expect(Array.isArray(r.json)).toBe(true)
  w.dispose(false)
})

test("the real TUI on a PTY: the Setup sheet appears in a new project; keys reach it; the cast records it", async () => {
  const w = world()
  const t = await zarg(w)
  await t.waitFor("not set up", 30_000)
  expect(t.screen()).toContain("zarg-router")
  t.press("esc")
  const code = await t.exit()
  expect(code).toBe(0)
  const cast = t.cast().split("\n")
  expect(JSON.parse(cast[0]!)).toMatchObject({ version: 2, width: 120, height: 40 })
  expect(cast.length).toBeGreaterThan(2)
  w.dispose(false)
}, 60_000)

test("the preflight fails with its message when nothing listens", async () => {
  await expect(preflight("http://127.0.0.1:9/api/v1", ["deepseek-v4.1-flash-exl3"])).rejects.toThrow("zarg-router at http://127.0.0.1:9/api/v1 does not list deepseek-v4.1-flash-exl3: start the router and load it")
})
```

- [ ] **Step 3: Run them and watch them fail**: `cd packages/e2e && mise x -- bun test test`. Expected: FAIL, because `../src` is not found.
- [ ] **Step 4: Implement** `world.ts`, `term.ts` and `preflight.ts` to the interfaces above, and `index.ts` re-exporting them. Implementation notes:
  - **`world.dispose(keep)`:** with `keep === false`, `rmSync` the three temp dirs recursively; with `true`, `console.error("kept world: <project>")`.
  - **`zarg()`:** check the TUI exits on Ctrl+D (`grep -n '"d"' packages/view-tui/src/layers.ts`). If another key quits, use it and note it in the ledger. Before starting a session, `zarg()` stops any core left in the world, with `core stop`, run with `cli`.
  - **`preflight()`:** fetch `${url}/models` with a 5 s timeout; any failure, or a model missing from `data[].id`, rejects with `zarg-router at ${url} does not list ${missing}: start the router and load it`. For a fetch failure the missing model is the first one asked for.
  - **The cast:** the header is `{"version":2,"width":120,"height":40,"timestamp":<unix>,"env":{"TERM":"xterm-256color"}}`, followed by one JSON event line per chunk.
- [ ] **Step 5: Run them and watch them pass**: `cd packages/e2e && mise x -- bun test test && mise x -- bunx tsc --noEmit -p .`. Expected: PASS. The PTY test needs the plugins built: run `mise run build:plugins` first.
- [ ] **Step 6: Commit**

```bash
mise run verify && git add packages/e2e bun.lock && git commit -m "feat(e2e): the harness: a fresh world, the CLI, the real TUI on a PTY with headless xterm and a cast, the preflight

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `journey()` and `proves()`: steps that write evidence

**Files:**
- Create: `packages/e2e/src/proof.ts`; export it from `src/index.ts`
- Test: `packages/e2e/test/proof.test.ts`

**Interfaces:**
- Consumes `scenarioVersion` (`@zarg/audit/version`), the `Evidence` and `Media` types (`@zarg/audit/evidence`; add `"./evidence": "./src/evidence.ts"` to audit's exports), and `World`, `Term` and `cli` from Task 4.
- Produces:
```ts
export type Tier = "fast" | "full"
export interface Step {
  readonly w: World
  /** The open terminal (opened by `open`), or undefined for CLI-only steps. */
  term?: Term
  readonly open: (args?: ReadonlyArray<string>) => Promise<Term>
  readonly cli: (args: ReadonlyArray<string>) => Promise<{ readonly code: number; readonly out: string; readonly err: string; readonly json: unknown }>
  /** Attach a text medium now (a CLI transcript, a log excerpt). */
  readonly note: (kind: "buffer" | "log", caption: string, text: string) => void
}
export const journey: (id: string, opts: { readonly tier: Tier; readonly seed?: Readonly<Record<string, string>> }, body: (proves: Proves) => void) => void
export type Proves = (scenario: string, fn: (s: Step) => Promise<void>, opts?: { readonly model?: boolean; readonly timeoutMs?: number }) => void
/** Where evidence goes: E2E_EVIDENCE_ROOT, else the zarg repo (REPO). */
export const evidenceRoot: () => string
```
- **Behaviour:**
  - **`journey(id, …)`:**
    - reads the graph from `evidenceRoot()/.zarg/graph/nodes/*.json` (as `Snapshot.make`) once;
    - is skipped with `describe.skip` when `E2E_TIER=fast` and its tier is `full`;
    - otherwise runs a bun `describe(id)` whose steps share one `world(seed)`, created before the first step and disposed after the last (kept when any step failed);
    - at the end, closes any open terminal.
  - **`proves(S, fn, opts)`:**
    1. Before running, check that `S` is a scenario in the graph and in journey `id` (an `in` edge to it). Otherwise throw `S-… is not a scenario of J-…`.
    2. Run `fn` in a bun `test` with `timeoutMs` (default 120 s; 300 s with `model`). With `model: true`, retry once on failure and mark `flaky: true` when the retry passes.
    3. Media, written under `evidenceRoot()/.zarg/evidence/media/<S>/`:
       - if a term is open, `before.txt` (the screen before) and `after.txt` (the screen after, or at the failure), both `buffer`;
       - `step.cast` (the cast from the step's start), `cast`;
       - each `note` as `note-<n>.txt` with its kind.
    4. Always write `evidenceRoot()/.zarg/evidence/<S>.json`, even when `fn` throws before opening anything:
       - the scenario's current version, from `scenarioVersion`;
       - `commit`: `git rev-parse --short HEAD` in `evidenceRoot()`;
       - `run`: one id per process, `e2e-<ISO time with ':' → '-'>`;
       - `journey`, `passed`, `flaky`, `at`, `ms`, `media`;
       - `failure`: `{ expected: <the error's message>, saw: <the screen, or the last note> }` on failure, else `null`.
    5. Write atomically: a temp file, then rename.
    6. Re-throw the failure so bun reports it.

- [ ] **Step 1: Write the failing tests** (`packages/e2e/test/proof.test.ts`). They use `E2E_EVIDENCE_ROOT` pointed at a temp dir holding a tiny graph, and run inside one test file through `bun test`'s own nesting. Run the journey in a child `bun test` so failures don't fail this file:

```ts
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "zt-proof-"))
  const nodes = join(root, ".zarg", "graph", "nodes")
  mkdirSync(nodes, { recursive: true })
  const w = (id: string, n: unknown) => writeFileSync(join(nodes, `${id}.json`), JSON.stringify(n))
  w("ST-0001", { id: "ST-0001", type: "gherkin/state", props: { text: "a" }, edges: [] })
  w("J-0001", { id: "J-0001", type: "gherkin/journey", props: { name: "J" }, edges: [] })
  w("J-0002", { id: "J-0002", type: "gherkin/journey", props: { name: "K" }, edges: [] })
  for (const [id, j] of [["S-0001", "J-0001"], ["S-0002", "J-0001"], ["S-0003", "J-0002"]] as const)
    w(id, { id, type: "gherkin/scenario", props: { title: id, when: "w" }, edges: [{ type: "gherkin/arrives", to: "ST-0001" }, { type: "gherkin/then", to: "ST-0001" }, { type: "gherkin/in", to: j }] })
  Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "g", "--allow-empty"], { cwd: root })
  return root
}
const runJourney = (root: string, body: string) => {
  const file = join(root, "j.test.ts")
  writeFileSync(file, `import { journey } from "${join(import.meta.dir, "../src")}"\n${body}`)
  return Bun.spawnSync([process.execPath, "test", file], { cwd: root, env: { ...process.env, E2E_EVIDENCE_ROOT: root } })
}
const evidence = (root: string, id: string) => JSON.parse(readFileSync(join(root, ".zarg", "evidence", `${id}.json`), "utf8"))

test("a passing CLI step writes evidence at the scenario's version with its notes as media", () => {
  const root = repo()
  runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0001", async (s) => { const r = await s.cli(["agenda"]); s.note("buffer", "zarg agenda", r.out) }) })`)
  const e = evidence(root, "S-0001")
  expect(e).toMatchObject({ scenario: "S-0001", journey: "J-0001", passed: true, flaky: false, failure: null })
  expect(e.version).toMatch(/^[0-9a-f]{12}$/)
  expect(e.media).toEqual([{ kind: "buffer", path: "media/S-0001/note-1.txt", caption: "zarg agenda" }])
})

test("a step that throws before anything still writes passed: false with the error", () => {
  const root = repo()
  runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0002", async () => { throw new Error("expected the agenda") }) })`)
  expect(evidence(root, "S-0002")).toMatchObject({ passed: false, failure: { expected: "expected the agenda" } })
})

test("a model step that passes on its retry is flaky; one naming another journey's scenario is refused", () => {
  const root = repo()
  runJourney(root, `let n = 0
journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0001", async () => { if (n++ === 0) throw new Error("bad answer") }, { model: true }) })`)
  expect(evidence(root, "S-0001")).toMatchObject({ passed: true, flaky: true })
  const r = runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0003", async () => {}) })`)
  expect(new TextDecoder().decode(r.stderr)).toContain("S-0003 is not a scenario of J-0001")
})

test("E2E_TIER=fast skips a full-tier journey (no evidence written)", () => {
  const root = repo()
  const file = join(root, "j.test.ts")
  writeFileSync(file, `import { journey } from "${join(import.meta.dir, "../src")}"\njourney("J-0001", { tier: "full" }, (proves) => { proves("S-0001", async () => {}) })`)
  Bun.spawnSync([process.execPath, "test", file], { cwd: root, env: { ...process.env, E2E_EVIDENCE_ROOT: root, E2E_TIER: "fast" } })
  expect(() => evidence(root, "S-0001")).toThrow()
})
```

- [ ] **Step 2: Run them and watch them fail**: `cd packages/e2e && mise x -- bun test test/proof.test.ts`. Expected: FAIL. Each child run errors on the missing export, so no evidence file exists.
- [ ] **Step 3: Implement `proof.ts`** to the behaviour above. Notes:
  - Read the graph with `Snapshot.make` over `JSON.parse` of each node file, skipping files that don't parse.
  - `journey` uses `describe` from `bun:test`, with `beforeAll` creating the world and `afterAll` closing the term and disposing the world (`keep = anyFailed`).
  - Media paths in evidence are relative to `.zarg/evidence/`.
  - The retry is a plain loop around `fn` (two attempts at most).
  - Count `note` files per step, starting at 1.
- [ ] **Step 4: Run them and watch them pass**: `cd packages/e2e && mise x -- bun test test && mise x -- bunx tsc --noEmit -p .`.
- [ ] **Step 5: Commit**

```bash
mise run verify && git add packages/e2e packages/audit && git commit -m "feat(e2e): journey and proves: steps that check the graph, retry model steps once, and write evidence with media

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The first journey: J-0005 CLI actor

**Files:**
- Create: `packages/e2e/journeys/J-0005.test.ts`
- Evidence: `.zarg/evidence/S-0001.json` … for the 12 scenarios of J-0005, with their media (committed)

**Interfaces:**
- Consumes `journey`, `proves` and `Step` (Task 5).

The 12 scenarios of J-0005 (from `zarg render`), each proven with `s.cli`, the transcript attached as `note("buffer", "<command>", out)`:

| Scenario | Step |
|---|---|
| S-0001 reads the agenda | `cli(["agenda"])`: an array with `priority` numbers in ascending order |
| S-0002 adds a scenario | `tool call gherkin/add-persona …`, `add-state …`, `add-scenario …`: `.zarg/graph/nodes/S-0001.json` exists; `render --focus S-0001` shows `Given` and `Then` lines with their state texts |
| S-0003 a conditional clause is refused | `add-scenario` with a When containing "if": exit 1, stderr names the `conditional` lint and "one scenario per case" |
| S-0006 retries with the hint | the same call reworded with no "if": saved (the node file exists) |
| S-0004 rewords a state | `edit-state` on the shared state: `render` shows the new text in every scenario using it |
| S-0007 a duplicate link is refused | `link` the same `then` state twice: the second exits 1 with `twice; remove the duplicate` |
| S-0005 lists changes since a ref | `diff --since <first commit>`: lists the added nodes |
| S-0079 finds the affected scenarios | `affected`: lists the scenarios added since the checkpoint |
| S-0081 finds a scenario's code | after seeding `src/a.ts` with an `@scenario` tag on that scenario: `query code <id>` lists `src/a.ts:<line>` |
| S-0082 tags new code | add a second tagged line, then `query code` lists both |
| S-0083 records a checkpoint | `checkpoint`: then `affected` is empty, and `git diff --cached --name-only` includes `.zarg/reconciled.json` |
| S-0080 finds the graph in sync | `affected` with nothing changed: reports in sync (an empty list or the in-sync message) |

- [ ] **Step 1: Write the journey.** Find each command's exact arguments with `mise run -q zarg -- --help` and `zarg <cmd> --help`, and the tag mark with `grep -n "MARK" packages/audit/src/index.ts`. Build the tag in the seed file with string concatenation, so this test file holds no tag of its own and doesn't trip the audit's orphan check. Example of the file's shape:

```ts
import { expect } from "bun:test"
import { journey } from "../src"

const TAG = "@" + "scenario"
journey("J-0005", { tier: "fast" }, (proves) => {
  proves("S-0001", async (s) => {
    const r = await s.cli(["agenda"])
    s.note("buffer", "zarg agenda", r.out)
    expect(r.code).toBe(0)
    const items = r.json as ReadonlyArray<{ priority: number }>
    expect(items.map((i) => i.priority)).toEqual([...items.map((i) => i.priority)].sort((a, b) => a - b))
  })
  // … one proves per scenario in the table above, in that order (the world is shared: later steps build on earlier ones)
})
```
  Write all 12 steps fully, with real arguments and assertions, in the table's order.
- [ ] **Step 2: Run it**: `mise run build:plugins && cd packages/e2e && E2E_TIER=fast mise x -- bun test journeys/J-0005.test.ts`. Expected: 12 pass, and `.zarg/evidence/S-*.json` written for them. Any failure is a real finding: fix the step if it misreads the scenario, or record the product bug in the ledger and fix it with a test in its own package.
- [ ] **Step 3: Check the audit**: `mise run -q zarg -- audit --summary | tail -1`. Expected: the count line shows `12 proven`, and `integrity 0`.
- [ ] **Step 4: Commit** (the journey and its evidence together):

```bash
mise run verify && git add packages/e2e/journeys/J-0005.test.ts .zarg/evidence && git commit -m "test(e2e): J-0005 CLI actor proven end to end (12 scenarios, evidence committed)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The tasks, the pre-push gate, and the docs

**Files:**
- Modify: root `mise.toml` (tasks `e2e`, `e2e:full`, `setup:hooks`)
- Create: `.githooks/pre-push`
- Modify: `.gitignore` (`e2e-artifacts/`, `.zarg/evidence/media/**/*.png`, `*.gif`, `*.mp4`, `*.webm`)
- Modify: `AGENTS.md` (the `packages/e2e` and `packages/audit` lines; Setup gains `mise run setup:hooks`)
- Create: `packages/e2e/src/run.ts` (the runner the tasks call)
- Test: `packages/e2e/test/run.test.ts`

**Interfaces:**
- Produces `run(opts: { tier: "fast" | "full"; only?: string; url: string }): Promise<number>`. It:
  1. runs `preflight(url, models)`. The models depend on the tier: the fast tier needs none, so the preflight is skipped when no fast journey has `model` steps; the full tier needs both `deepseek-v4.1-flash-exl3` and `jevk5`;
  2. runs each `journeys/J-*.test.ts` in turn (or the one named by `only`), as `bun test <file>` with `E2E_TIER=<tier>`;
  3. prints a summary (journeys passed, failed and flaky);
  4. answers the exit code: 0 when all passed, else 1.

- [ ] **Step 1: Write the failing test** (`packages/e2e/test/run.test.ts`): `run({ tier: "full", url: "http://127.0.0.1:9/api/v1" })` rejects with the preflight message, and `run({ tier: "fast", only: "J-9999", url: "…" })` rejects with `no journey J-9999 (journeys/J-9999.test.ts)`.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `run.ts`** with a CLI entry: `if (import.meta.main)` parse `--full` and a positional journey id; `E2E_ZARG_ROUTER_URL` defaults to `http://localhost:11435/api/v1`; then `process.exit(await run(...))`.
- [ ] **Step 4: The tasks** (root `mise.toml`):

```toml
[tasks.e2e]
description = "End-to-end proof, fast tier: journeys with no model turns, on a fresh project each (mise run e2e -- J-0005 for one)"
depends = ["build:plugins"]
run = "mise x -- bun packages/e2e/src/run.ts"

[tasks."e2e:full"]
description = "End-to-end proof, every journey, on the live zarg-router models (deepseek-v4.1-flash-exl3, jevk5)"
depends = ["build:plugins"]
run = "mise x -- bun packages/e2e/src/run.ts --full"

[tasks."setup:hooks"]
description = "Use the repo's git hooks (.githooks): e2e before every push"
run = "git config core.hooksPath .githooks"
```
`.githooks/pre-push` (executable):
```sh
#!/bin/sh
# Every push proves the fast tier end to end; `git push --no-verify` skips it.
exec mise run -q e2e
```
- [ ] **Step 5: Run them and watch them pass**: `cd packages/e2e && mise x -- bun test test`, then `mise run e2e`. Expected: J-0005 passes, with no router needed for the fast tier.
- [ ] **Step 6: Docs.** AGENTS.md:
  - **`packages/e2e`** (`@zarg/e2e`): end-to-end proof. Real `zarg` runs in a fresh project and user dir per journey, on a Bun PTY read through headless xterm. `journey("J-…")` and `proves("S-…")` walk the graph's journeys and write `.zarg/evidence/<S-id>.json` with media (`buffer`, `cast`, `log` committed; binary media gitignored). `mise run e2e` runs the fast tier before a push; `mise run e2e:full` runs everything on the live zarg-router.
  - **`packages/audit`:** it is now the one CI check (`zarg audit`: structure, lints, completeness, coverage, code, proof, integrity; `--json`, `--junit`, exit 0/1/2).
  - **Setup** adds `mise run setup:hooks`.
- [ ] **Step 7: Commit**

```bash
mise run verify && git add mise.toml .githooks .gitignore AGENTS.md packages/e2e && git commit -m "feat(e2e): mise run e2e / e2e:full, a pre-push gate, the docs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage, plan 1's part:**
  - the harness: Tasks 4 and 5;
  - evidence and media (`buffer`, `cast`, `log`; binary media gitignored): Tasks 2, 5 and 7;
  - one CI audit with every check, `--json`, `--junit` and exit codes: Task 3;
  - the graph decides what is walked (the journey and scenario check): Task 5;
  - tiers, tasks and the gate: Task 7;
  - the first journey proven: Task 6.
- **Left to later plans:**
  - the catalog (plan 2);
  - red becomes work, the evidence watcher (plan 3);
  - the graph catch-up, coverage of J-0001..J-0004 and the strict switch (plan 4).
- **Rulings:**
  - **J-0005 needs no TUI:** its proof is CLI transcripts (`buffer` notes). The cast and PTY are exercised by the harness test and used by later journeys.
  - **The fast tier's preflight is skipped** when no fast journey has model steps: a push shouldn't need the router for CLI-only journeys.
  - **The scenario version moves to `@zarg/audit/version`,** so the audit and the harness can compute it without the plugin host.
