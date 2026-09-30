# Card Code Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every card is either tagged in the code (`// @card <id>`) or marked `planned`, and `zarg audit` (run by `mise run verify`) fails when that stops being true.

**Architecture:**
- A new dependency-free package `@zarg/audit` finds tags with one `git grep` and checks them against a graph snapshot.
- Gherkin gains a `planned` card field, which render shows and `affected` ignores.
- The CLI gains `zarg audit`, and `query code` finds tags in untracked files too.
- The Planner clears `planned` on cards a reconcile pass lands.
- A one-time backfill tags the 70 built cards and plans the 13 unbuilt ones.

**Tech Stack:** Bun, Effect 4, `effect/unstable/cli`, git.

**Spec:** `docs/superpowers/specs/2026-09-29-card-code-audit-design.md`. Evidence for the backfill: `docs/superpowers/specs/2026-09-29-cards-vs-code-audit.md`.

## Global Constraints

- A tag is a comment, `// @card <id>` (or `#` / `<!-- -->`); one line may name several cards: `// @card UX-0040 UX-0041`.
- "Built" is never stored; it is the presence of tags. Only `planned: true` is stored on a card.
- Tags are found in tracked and untracked files, never in ignored ones, and never under `docs/`: specs and plans quote tags as examples.
- Source that must contain the literal text of a tag without being one (tests of the audit itself) builds it: `const TAG = "@" + "card"`.
- Tool versions and tasks live in `mise.toml`; run everything through `mise x -- bun …`.
- `mise run build:plugins && mise run verify` passes before every commit. Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never edit `.zarg/graph` by hand: change cards with `mise run -q zarg -- tool call gherkin/edit-card '<json>'`.

## Review Focus

1. **A test or fixture that writes a tag as literal text:** the audit counts it and reports it as an orphan or a false tag. Pinned in Task 1 ("tags built from parts are not tags") and fixed across the repo in Task 5.
2. **A tag naming a node that is not a card** (`@card S-0001`): an orphan, not "built". Pinned in Task 1.
3. **Clearing `planned` makes a card look changed to reconcile,** which re-implements it for nothing. Pinned in Task 2 ("a change to planned alone affects no card").
4. **A tag in `docs/`** (specs quote `// @card UX-0020`): ignored. Pinned in Task 1's `tags` test.
5. **`zarg audit` must exit 1 on problems, but still print JSON on stdout** for CI logs and agents. Pinned in Task 3.

---

### Task 1: `@zarg/audit`, the check

**Files:**
- Create: `packages/audit/package.json`, `packages/audit/tsconfig.json`, `packages/audit/mise.toml`, `packages/audit/src/index.ts`
- Test: `packages/audit/test/audit.test.ts`

**Interfaces:**
- Produces:
  - `type Tag = { id: string; file: string; line: number }`
  - `parseTags(grep: string): Array<Tag>`
  - `audit(snap: Snapshot.Snapshot, tags: ReadonlyArray<Tag>): Report`
  - `tags(root: string): Effect<Array<Tag>, Error>`
  - `summary(r: Report): string`
  - `CARD = "gherkin/card"`
  - `Report = { cards: Array<{ id; title; status: "built" | "planned"; tags: Array<{ file; line }> }>; problems: Array<Problem> }`
  - `Problem = { kind: "untagged"; card; title } | { kind: "planned-but-tagged"; card; title; tags } | { kind: "orphan"; id; file; line }`

- [ ] **Step 1: Scaffold the package** (like `packages/bm25`)

`packages/audit/package.json`:
```json
{
  "name": "@zarg/audit",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@zarg/graph": "workspace:*", "effect": "^4.0.0-rc.117" }
}
```
`packages/audit/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`
`packages/audit/mise.toml`:
```toml
[tasks.typecheck]
run = "mise x -- bunx tsc"

[tasks.test]
run = "mise x -- bun test"
```
Run: `cd /home/demiurge/Git/zarg-v2 && mise x -- bun install`. Expected: `bun.lock` gains `@zarg/audit`.

- [ ] **Step 2: Write the failing tests**

`packages/audit/test/audit.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Snapshot } from "@zarg/graph/pure"
import { audit, parseTags, summary, tags } from "../src/index"

// Built from parts, so this file holds no tag of its own.
const TAG = "@" + "card"
const card = (id: string, props: Record<string, unknown> = {}) => ({ id, type: "gherkin/card", props: { title: `card ${id}`, when: "w", ...props }, edges: [] })
const snap = Snapshot.make([card("UX-0001"), card("UX-0002", { planned: true }), card("UX-0003"), card("UX-0004", { planned: true }), { id: "S-0001", type: "gherkin/state", props: { text: "s" }, edges: [] }])

describe("the card audit", () => {
  test("parseTags: file, line and every id a tag names", () => {
    expect(parseTags([`src/a.ts:3:// ${TAG} UX-0001`, `src/b.ts:10:  foo() // ${TAG} UX-0003 UX-0004`, `README.md:1:<!-- ${TAG} UX-0003 -->`].join("\n"))).toEqual([
      { id: "UX-0001", file: "src/a.ts", line: 3 },
      { id: "UX-0003", file: "src/b.ts", line: 10 },
      { id: "UX-0004", file: "src/b.ts", line: 10 },
      { id: "UX-0003", file: "README.md", line: 1 },
    ])
  })
  test("built, planned, and the three problems; a tag on a state or a missing card is an orphan", () => {
    const r = audit(snap, [
      { id: "UX-0001", file: "src/a.ts", line: 3 },
      { id: "UX-0004", file: "src/b.ts", line: 10 },
      { id: "UX-0099", file: "src/c.ts", line: 1 },
      { id: "S-0001", file: "src/d.ts", line: 2 },
    ])
    expect(r.cards.map((c) => [c.id, c.status, c.tags.length])).toEqual([["UX-0001", "built", 1], ["UX-0002", "planned", 0], ["UX-0003", "built", 0], ["UX-0004", "planned", 1]])
    expect(r.problems).toEqual([
      { kind: "untagged", card: "UX-0003", title: "card UX-0003" },
      { kind: "planned-but-tagged", card: "UX-0004", title: "card UX-0004", tags: [{ file: "src/b.ts", line: 10 }] },
      { kind: "orphan", id: "UX-0099", file: "src/c.ts", line: 1 },
      { kind: "orphan", id: "S-0001", file: "src/d.ts", line: 2 },
    ])
    expect(summary(r)).toBe(
      [
        "untagged            UX-0003 card UX-0003",
        "planned-but-tagged  UX-0004 src/b.ts:10",
        "orphan              UX-0099 src/c.ts:1",
        "orphan              S-0001 src/d.ts:2",
        "1 built · 2 planned · 1 untagged · 1 planned-but-tagged · 2 orphan",
      ].join("\n"),
    )
  })
  test("tags: tracked and untracked files; never ignored ones or docs/; tags built from parts are not tags", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-audit-"))
    Bun.spawnSync(["git", "init", "-q"], { cwd: root })
    mkdirSync(join(root, "src"))
    mkdirSync(join(root, "docs"))
    writeFileSync(join(root, "src/tracked.ts"), `// ${TAG} UX-0001\n`)
    Bun.spawnSync(["git", "add", "src/tracked.ts"], { cwd: root })
    writeFileSync(join(root, "src/new.ts"), `x() // ${TAG} UX-0002\n`)
    writeFileSync(join(root, ".gitignore"), "ignored.ts\n")
    writeFileSync(join(root, "ignored.ts"), `// ${TAG} UX-0003\n`)
    writeFileSync(join(root, "docs/plan.md"), `// ${TAG} UX-0004\n`)
    writeFileSync(join(root, "src/test.ts"), 'const TAG = "@" + "card"\n')
    const found = await Effect.runPromise(tags(root))
    expect(found.map((t) => `${t.id} ${t.file}:${t.line}`).sort()).toEqual(["UX-0001 src/tracked.ts:1", "UX-0002 src/new.ts:1"])
  })
})
```

- [ ] **Step 3: Run the tests to watch them fail**

Run: `cd packages/audit && mise x -- bun test`. Expected: FAIL (`Cannot find module '../src/index'`).

- [ ] **Step 4: Implement**

`packages/audit/src/index.ts`:
```ts
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
```

`built` in the summary counts cards that have tags; an untagged card that isn't planned is counted under `untagged`, not `built`.

- [ ] **Step 5: Run the tests**

Run: `cd packages/audit && mise x -- bun test && mise x -- bunx tsc`. Expected: PASS, and typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /home/demiurge/Git/zarg-v2 && mise run build:plugins && mise run verify && git add packages/audit bun.lock && git commit -m "feat(audit): @zarg/audit checks cards against their @card tags (untagged, planned-but-tagged, orphan)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 2: Gherkin, the `planned` field

**Files:**
- Modify: `packages/plugin-gherkin/src/tools.ts:180-193` (`editCard`), `packages/plugin-gherkin/src/render.ts:17-19`, `packages/plugin-gherkin/src/affected.ts:16-20`
- Test: `packages/plugin-gherkin/test/render.test.ts`, `packages/plugin-gherkin/test/affected.test.ts`

**Interfaces:**
- Produces: `gherkin/edit-card` accepts `planned: boolean` (`true` sets it; `false` removes the prop). Render prints `  Status planned` after the title line of a planned card. `affectedCards` ignores a card change that touches only `planned`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/plugin-gherkin/test/render.test.ts`, following that file's harness (`run`, `pricing`, `call` from `./harness`):
```ts
test("a planned card says so under its title; planned: false clears it", async () => {
  const [on, off] = await run(
    Effect.gen(function* () {
      yield* pricing
      yield* call("edit-card", { id: "UX-0003", planned: true })
      const on = yield* PluginHost.use((h) => h.render(new Set(["UX-0003"])))
      yield* call("edit-card", { id: "UX-0003", planned: false })
      const off = yield* PluginHost.use((h) => h.render(new Set(["UX-0003"])))
      return [on, off] as const
    }),
  )
  expect(on.split("\n").slice(0, 2)).toEqual(["UX-0003 Visitor picks Pro", "  Status planned"])
  expect(off).not.toContain("Status")
})
```
Append to `packages/plugin-gherkin/test/affected.test.ts`, using that file's fixtures (read it first; it builds `before`/`after` snapshots):
```ts
test("a change to planned alone affects no card", () => {
  const c = { id: "UX-0001", type: "gherkin/card", props: { title: "t", when: "w" }, edges: [] }
  const before = Snapshot.make([c])
  const after = Snapshot.make([{ ...c, props: { ...c.props, planned: true } }])
  expect(affectedCards(before, after).cards).toEqual([])
  expect(affectedCards(after, Snapshot.make([{ ...c, props: { ...c.props, when: "w2", planned: true } }])).cards).toEqual(["UX-0001"])
})
```

- [ ] **Step 2: Run them to watch them fail**

Run: `cd packages/plugin-gherkin && mise x -- bun test test/render.test.ts test/affected.test.ts`. Expected: FAIL (`planned` is not a param of edit-card; UX-0001 is affected).

- [ ] **Step 3: Implement**

`tools.ts` `editCard`:
```ts
export const editCard = tool({
  name: "edit-card",
  description: "Change a card's title or When, or mark it planned (true: not built yet; false: clears it).",
  params: Schema.Struct({
    id: Schema.String,
    title: Schema.optionalKey(Schema.NonEmptyString),
    when: Schema.optionalKey(Schema.NonEmptyString),
    planned: Schema.optionalKey(Schema.Boolean),
  }),
  run: ({ id, planned, ...patch }, snap) =>
    Effect.map(getNode(snap, id, CARD), (n) => {
      const { planned: _, ...rest } = n.props
      const props = { ...rest, ...patch, ...(planned === true || (planned === undefined && n.props.planned === true) ? { planned: true } : {}) }
      return { changes: [Put({ ...n, props })], message: `updated ${id}` }
    }),
})
```
`render.ts`, in `renderCard`'s array, after the title line:
```ts
    `${card.id} ${String(card.props.title)}`,
    ...(card.props.planned === true ? ["  Status planned"] : []),
```
`affected.ts`, in the `d.changed` loop:
```ts
  const withoutPlanned = (n: { props: Record<string, unknown> }) => {
    const { planned: _, ...rest } = n.props
    return rest
  }
  for (const c of d.changed) {
    // Marking a card planned (or clearing it) changes nothing to implement.
    if (c.after.type === CARD && JSON.stringify(withoutPlanned(c.before)) === JSON.stringify(withoutPlanned(c.after)) && JSON.stringify(c.before.edges) === JSON.stringify(c.after.edges)) continue
    if (c.after.type === CARD) cards.add(c.id)
```
(Check that `diff`'s changed entries carry `before`; read `packages/graph/src/diff.ts`. If they carry only `after`, look the node up in `before` with `before.nodes.get(c.id)`.)

- [ ] **Step 4: Run the tests**

Run: `cd packages/plugin-gherkin && mise x -- bun test && mise x -- bunx tsc`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/demiurge/Git/zarg-v2 && mise run build:plugins && mise run verify && git add packages/plugin-gherkin packages/plugin/src/server/first-party-hashes.ts && git commit -m "feat(gherkin): a card can be planned (edit-card planned), render says Status planned, and affected ignores it

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 3: `zarg audit`, and `query code` over untracked files

**Files:**
- Modify: `packages/cli/package.json` (add `"@zarg/audit": "workspace:*"`), `packages/cli/src/commands.ts`, `packages/cli/src/git.ts:31-37`
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `audit`, `tags`, `summary` from `@zarg/audit`
- Produces: `zarg audit [--summary] [--card <id>]`. JSON `Report` on stdout (or the summary text), with exit code 1 when `problems` is not empty. `--card` prints that card's report entry only, and exits 0.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("zarg cli", …)` in `packages/cli/test/cli.test.ts`. The describe's temp repo already has UX-0001 from the first test. Build tags from parts:
```ts
  test("audit: JSON with exit 1 while a card has no tag; --summary; clean once tagged or planned", () => {
    const TAG = "@" + "card"
    const before = zarg("audit")
    expect(before.code).toBe(1)
    expect(JSON.parse(before.out).problems).toContainEqual({ kind: "untagged", card: "UX-0001", title: "Open pricing" })
    expect(zarg("audit", "--summary").out).toContain("untagged            UX-0001 Open pricing")
    // A new, untracked file's tag counts (and query code finds it).
    Bun.write(join(dir, "pricing.ts"), `export const open = () => 1 // ${TAG} UX-0001\n`)
    const others = (JSON.parse(zarg("audit").out).problems as Array<{ kind: string; card?: string }>).filter((p) => p.card === "UX-0001")
    expect(others).toEqual([])
    expect(json("query", "code", "UX-0001")).toEqual(["pricing.ts:1:export const open = () => 1 // " + TAG + " UX-0001"])
    expect(json("audit", "--card", "UX-0001")).toMatchObject({ id: "UX-0001", status: "built", tags: [{ file: "pricing.ts", line: 1 }] })
  })
```
(If other cards made by earlier tests in the describe are untagged, the exit code stays 1: assert only on UX-0001, as above.)

- [ ] **Step 2: Run it to watch it fail**

Run: `cd packages/cli && mise x -- bun test test/cli.test.ts -t audit`. Expected: FAIL (unknown subcommand `audit`).

- [ ] **Step 3: Implement**

`git.ts`: replace `cardRefs` so it greps untracked files too, keeping its `path:line:text` output:
```ts
/** `path:line:text` hits for `@card <id>` in tracked and untracked files (not ignored ones). */
export const cardRefs = (root: string, id: string) =>
  sh(root, ["grep", "-n", "--untracked", "-w", "-e", `@card ${id}`]).pipe(
```
(Keep the rest of its body unchanged.)

`commands.ts`: import from `@zarg/audit` and add the command next to `affected`:
```ts
import { audit as auditOf, summary as auditSummary, tags as auditTags } from "@zarg/audit"

// @card UX-0079
const auditCmd = Command.make(
  "audit",
  {
    summary: Flag.Boolean("summary").pipe(Flag.withDescription("a line per problem and the counts, for people and CI logs")),
    card: Flag.String("card").pipe(Flag.optional, Flag.withDescription("one card's status and tags")),
  },
  (o) =>
    Effect.gen(function* () {
      const snap = yield* GraphStore.use((s) => s.snapshot)
      const report = auditOf(snap, yield* auditTags(root))
      if (Option.isSome(o.card)) return yield* print(report.cards.find((c) => c.id === o.card.value) ?? { id: o.card.value, missing: true })
      yield* print(o.summary ? auditSummary(report) : report)
      if (report.problems.length > 0) yield* Effect.sync(() => { process.exitCode = 1 })
    }),
)
```
Add `auditCmd` to the root `Command.withSubcommands([...])` list (`commands.ts:226`). Move the misplaced `// @card UX-0020` on `affected` to `// @card UX-0079`, and `// @card UX-0022` on `checkpoint` to `// @card UX-0083`. The audit says those are the cards they implement.

- [ ] **Step 4: Run the tests**

Run: `cd packages/cli && mise x -- bun test test/cli.test.ts && mise x -- bunx tsc`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/demiurge/Git/zarg-v2 && mise x -- bun install && mise run build:plugins && mise run verify && git add packages/cli bun.lock && git commit -m "feat(cli): zarg audit (JSON or --summary, exit 1 on problems, --card); query code finds tags in untracked files

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 4: Keeping `planned` in line

**Files:**
- Modify: `packages/core/src/planner.ts:95-105` (`landed`), `.claude/skills/zarg-implement/SKILL.md`
- Test: `packages/core/test/planner.test.ts`

**Interfaces:**
- Consumes: `gherkin/edit-card {id, planned: false}` (Task 2), the Planner's existing `d.calls`.
- Produces: after a pass lands cards, each landed card's `planned` flag is cleared.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/planner.test.ts`, follow the file's existing fake deps: it builds `PlannerDeps` with a recorded `calls`. Add:
```ts
test("a landed pass clears planned on its cards", async () => {
  const seen: Array<{ name: string; params: unknown }> = []
  const p = makePlanner({ ...fakeDeps(), calls: (list, hooks) => Effect.andThen(Effect.sync(() => seen.push(...list)), Effect.flatMap(hooks.before, (b) => hooks.after(b, []))) })
  await Effect.runPromise(p.landed(["UX-0026", "UX-0031"]))
  expect(seen).toEqual([
    { name: "gherkin/edit-card", params: { id: "UX-0026", planned: false } },
    { name: "gherkin/edit-card", params: { id: "UX-0031", planned: false } },
  ])
})
```
(Use the file's own names for the factory and the fake deps; `makePlanner` and `fakeDeps` stand for whatever it defines.)

- [ ] **Step 2: Run it to watch it fail**

Run: `cd packages/core && mise x -- bun test test/planner.test.ts`. Expected: FAIL (no calls recorded).

- [ ] **Step 3: Implement**

At the start of `landed`'s generator in `planner.ts`:
```ts
      // Landed cards are built now: planned is cleared (affected ignores it, so no pass follows).
      yield* Effect.ignore(d.calls(cards.map((id) => ({ name: "gherkin/edit-card", params: { id, planned: false } })), { before: Effect.void, failure: () => Effect.void, after: () => Effect.void }))
```
In `.claude/skills/zarg-implement/SKILL.md`, after step 4's "Tag the implementation and its tests with `// @card <id>`" line, add:
```markdown
5. Run `mise run -q zarg -- audit --card <id>`. When it shows the card's tags and `status: planned`, clear the flag: `mise run -q zarg -- tool call gherkin/edit-card '{"id":"<id>","planned":false}'`.
```
Renumber the following steps.

- [ ] **Step 4: Run the tests**

Run: `cd packages/core && mise x -- bun test test/planner.test.ts && mise x -- bunx tsc`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/demiurge/Git/zarg-v2 && mise run build:plugins && mise run verify && git add packages/core .claude/skills/zarg-implement && git commit -m "feat(planner): a landed pass clears planned on its cards; zarg-implement clears it too

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 5: Backfill, and the audit in `verify`

**Files:**
- Modify: code files named by the audit's evidence (tags only, no behaviour change), `mise.toml`, `AGENTS.md`
- Graph: `.zarg/graph` through `zarg tool call` only

**Interfaces:**
- Consumes: `zarg audit --summary` (Task 3), `gherkin/edit-card planned` (Task 2).

- [ ] **Step 1: Mark the 13 unbuilt cards planned**

```bash
cd /home/demiurge/Git/zarg-v2
for id in UX-0017 UX-0018 UX-0019 UX-0026 UX-0027 UX-0028 UX-0029 UX-0031 UX-0032 UX-0033 UX-0035 UX-0036 UX-0039; do
  mise run -q zarg -- tool call gherkin/edit-card "{\"id\":\"$id\",\"planned\":true}"
done
```
Expected: 13 × `updated UX-00xx`.

- [ ] **Step 2: Tag the built cards, journey by journey**

For each card that `mise run -q zarg -- audit --summary` lists as `untagged`, take the evidence from `docs/superpowers/specs/2026-09-29-cards-vs-code-audit.md` or re-find the code. Then add `// @card <id>` on the function, handler or component that does what the card says, and on its test when one exists.
- Tag only; change no behaviour.
- A unit serving several cards gets one tag line naming them all (`// @card UX-0063 UX-0064 UX-0065`).
- Put a tag above a `const`/`function`, or at the end of the line that does it.

Do one journey per commit, re-running the audit after each:
- CLI actor: UX-0001..0007, UX-0079..0083.
- Reconcile: UX-0020..0025, UX-0049..0059.
- Talk with zarg: UX-0008..0016, UX-0071..0078.
- Set up: UX-0030, UX-0034, UX-0037, UX-0038, UX-0060..0070.
- Watch agents: UX-0040..0048, UX-0073, UX-0074.

Run: `mise run -q zarg -- audit --summary`. Expected after each journey: no `untagged` line for that journey's cards.

- [ ] **Step 3: Clear false tags and orphans**

`zarg audit --summary` lists `orphan` lines: tests or fixtures that write `@card UX-…` as literal text, and removed cards.
- Rewrite literal tag text as `"@" + "card"` in test source.
- Delete tags for cards that no longer exist.

Expected: `mise run -q zarg -- audit` exits 0.

- [ ] **Step 4: Put the audit in verify**

`mise.toml`: add
```toml
[tasks.audit]
description = "Every card is tagged in the code or planned; no tag names a missing card (zarg audit)"
depends = ["//...:build"]
run = "mise x -- bun packages/cli/src/main.ts audit --summary"
```
and change `[tasks.verify]` `depends` to `["//...:typecheck", "//...:test", "audit"]`.

`AGENTS.md`:
- In the Requirements section, after the `// @card <id>` rule, add: "A card with no code yet is `planned` (`gherkin/edit-card {"planned": true}`); `mise run audit` (part of `verify`) fails on an untagged card, a planned card with tags, or a tag naming no card."
- Add a Packages line: "`packages/audit` (`@zarg/audit`): checks cards against their `@card` tags (`zarg audit`): untagged, planned-but-tagged, orphan; tags come from one `git grep` over tracked and untracked files, never `docs/`."

- [ ] **Step 5: Verify and commit**

Run: `mise run build:plugins && mise run verify`. Expected: PASS, including `audit`.
```bash
git add -A packages .claude .zarg/graph mise.toml AGENTS.md && git commit -m "chore: every card tagged or planned; zarg audit runs in verify

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
