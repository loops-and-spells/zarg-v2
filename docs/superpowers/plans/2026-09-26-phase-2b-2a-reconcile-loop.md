# Phase 2b-2a: The Durable Reconcile Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@zarg/reconcile`, the phase-agnostic loop behind plan and implement: it finds the cards a graph change affects, runs phases per card (shared or per-card git worktrees), merges, verifies with fix attempts, squashes one commit (graph, plans, code, checkpoint) and lands it on your branch, as a durable Effect workflow that resumes after a crash.

**Architecture:** Plain git plumbing (`git.ts`, `checkpoint.ts`, `worktree.ts`, `merge.ts`, `land.ts`) is tested in throwaway repos. `pass.ts` defines one `Workflow` whose every side effect is an idempotent `Activity`; the phases, verify, fix and resolve steps come from a `ReconcileSpec`, so this plan tests them with stub phases and plan 2b-2b plugs in the real RLMs. `engine.ts` runs workflows on `SingleRunner` + `bun:sqlite`; `reconciler.ts` watches `.zarg/graph` and triggers a pass after a quiet period, one at a time.

**Tech Stack:** bun 1.4.2 (via mise), Effect `4.0.0-rc.117` (`effect/unstable/workflow`, `effect/unstable/cluster`), `@effect/sql-sqlite-bun` `4.0.0-rc.117`, git.

**Spec:** `docs/superpowers/specs/2026-09-26-plan-implement-design.md` (Durability, The pass, Landing, Findings). Intent: `intent/zarg.md`. Plan 2b-2b wires this into the core with the planner and implementer RLMs, threads, the agenda, config, renames and the live smoke test.

## Global Constraints

- Run bun only as `mise x -- bun ...`; tests spawn `process.execPath`.
- No model anywhere in this plan: phases are stubs.
- Git is required. Tests create throwaway repos under the OS temp dir (`test/repo.ts`); never touch the zarg repo's own git state.
- Every side effect inside the workflow is an `Activity`, and every Activity is idempotent (an interrupted one runs again). The workflow body only branches on Activity results.
- Unstable Effect APIs (`effect/unstable/*`) are accepted.
- `mise run verify` must pass at the end of every task. Commit after every task, ending the message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every code block was prototyped and passes (`mise run verify` green on the prototype).

### Deliberate differences from the spec

- Cards whose phase failed still have their **graph files** in the pass commit (the whole reconciled graph tree is committed, so the checkpoint always matches the committed graph); only their plans and code are missing, and a finding is open. The spec said failed cards are left out of the commit.
- A sixth finding kind, `pass-error`, covers a pass that cannot start (detached HEAD, a merge or rebase in progress) or fails unexpectedly.
- Findings about cards a pass takes up again are cleared when that pass starts (the change supersedes them), as well as when it lands.
- Worktrees stay out of git through a `.zarg/reconcile/.gitignore` containing `*`, written on first use, instead of an entry in the repository's `.gitignore`.
- Landing restores the working state of **every** graph path the commit touches, not only dirty ones, so a card the driver removed or reverted after the pass read it is never brought back.
- The landing wait is `landRetry` × `landAttempts` (the core sets 60 s × 10 in 2b-2b).
- `gcPasses` (keep the newest 3 failed pass worktrees) is built and exported here; the core calls it before each pass in 2b-2b.

## Review Focus

1. A card the driver edits or removes after the pass read the graph must keep its newest working state after landing (Task 4 tests).
2. A pass killed mid-way must resume without re-running finished cards, and land once (Task 6 test).
3. You commit on the branch during a pass: the pass rebases, verifies again and lands on top of your commit (Task 6 test).
4. Your uncommitted edit in a file the commit changes: landing waits, then raises a finding, and your edit is untouched (Task 6 test).
5. A resolver that claims success but leaves conflict markers is treated as unresolved (Task 3 test).

---

### Task 1: Affected cards

**Files:**
- Create: `packages/plugin-gherkin/src/server/affected.ts`
- Modify: `packages/plugin-gherkin/src/server/index.ts`
- Test: `packages/plugin-gherkin/test/affected.test.ts`

**Interfaces:**
- Produces: `affectedCards(before: Snapshot, after: Snapshot): { cards: string[]; removed: string[] }` (sorted): added and changed cards, cards using a state whose text changed (arrives, given or then), and removed cards.

- [ ] **Step 1: Write the failing test**

`packages/plugin-gherkin/test/affected.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph"
import { affectedCards } from "../src/server"

const state = (id: string, text: string) => ({ id, type: "gherkin/state", props: { text }, edges: [] })
const card = (id: string, arrives: string, then: ReadonlyArray<string>, when = "the user acts") => ({
  id,
  type: "gherkin/card",
  props: { title: id, when },
  edges: [{ type: "gherkin/arrives", to: arrives }, ...then.map((t) => ({ type: "gherkin/then", to: t }))],
})
const snap = (...nodes: ReadonlyArray<ReturnType<typeof state> | ReturnType<typeof card>>) => Snapshot.make(nodes as never)

describe("affectedCards", () => {
  const base = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), card("UX-1", "S-1", ["S-2"]), card("UX-2", "S-2", ["S-3"]))

  test("added and changed cards are affected; untouched ones are not", () => {
    const after = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), card("UX-1", "S-1", ["S-2"], "the user taps"), card("UX-2", "S-2", ["S-3"]), card("UX-3", "S-3", ["S-1"]))
    expect(affectedCards(base, after)).toEqual({ cards: ["UX-1", "UX-3"], removed: [] })
  })

  test("a reworded state affects every card that arrives at or leads to it", () => {
    const after = snap(state("S-1", "home"), state("S-2", "basket"), state("S-3", "paid"), card("UX-1", "S-1", ["S-2"]), card("UX-2", "S-2", ["S-3"]))
    expect(affectedCards(base, after)).toEqual({ cards: ["UX-1", "UX-2"], removed: [] })
  })

  test("removed cards are listed separately; nothing changed means nothing affected", () => {
    const after = snap(state("S-1", "home"), state("S-2", "cart"), state("S-3", "paid"), card("UX-1", "S-1", ["S-2"]))
    expect(affectedCards(base, after)).toEqual({ cards: [], removed: ["UX-2"] })
    expect(affectedCards(base, base)).toEqual({ cards: [], removed: [] })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/plugin-gherkin && mise x -- bun test test/affected.test.ts`
Expected: FAIL (`affectedCards` is not exported).

- [ ] **Step 3: Implement**

`packages/plugin-gherkin/src/server/affected.ts`:

```ts
import { diff, Snapshot } from "@zarg/graph"
import { CARD, STATE } from "./model"

export interface Affected {
  /** Cards to (re)implement: added, changed, or using a state whose text changed. Sorted. */
  readonly cards: ReadonlyArray<string>
  /** Cards that no longer exist. Sorted. */
  readonly removed: ReadonlyArray<string>
}

/** Cards a graph change affects: what plan and implement must reconcile between `before` and `after`. */
export const affectedCards = (before: Snapshot.Snapshot, after: Snapshot.Snapshot): Affected => {
  const d = diff(before, after)
  const cards = new Set<string>()
  for (const n of d.added) if (n.type === CARD) cards.add(n.id)
  for (const c of d.changed) {
    if (c.after.type === CARD) cards.add(c.id)
    // A reworded state changes every card that uses it (arrives, given or then).
    else if (c.after.type === STATE) for (const e of Snapshot.inbound(after, c.id)) if (after.nodes.get(e.from)?.type === CARD) cards.add(e.from)
  }
  const removed = d.removed.filter((n) => n.type === CARD).map((n) => n.id)
  return { cards: [...cards].sort(), removed: removed.sort() }
}
```

In `packages/plugin-gherkin/src/server/index.ts`, replace `export * from "./model"` with:

```ts
export * from "./affected"
export * from "./model"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/plugin-gherkin && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (all plugin-gherkin tests, including 3 new).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/plugin-gherkin
git commit -m "feat(plugin-gherkin): affectedCards: the cards a graph change affects"
```

---

### Task 2: The package, git plumbing and the checkpoint

**Files:**
- Create: `packages/reconcile/package.json`, `packages/reconcile/tsconfig.json`, `packages/reconcile/mise.toml`
- Create: `packages/reconcile/src/git.ts`, `src/checkpoint.ts`, `src/index.ts`
- Test: `packages/reconcile/test/repo.ts` (throwaway repo helpers), `packages/reconcile/test/checkpoint.test.ts`

**Interfaces:**
- Produces: `GitError`, `gitRun(cwd, args, env?) → { code, stdout, stderr }` (never fails), `git(cwd, args, env?) → stdout` (fails with `GitError`), `EMPTY_TREE`; `GRAPH = ".zarg/graph"`, `CHECKPOINT = ".zarg/reconciled.json"`, `LEGACY_CHECKPOINT = ".zarg/sync.json"`; `workingGraphTree(repo)` (tree id of the working graph, via a throwaway index), `baseTree(repo, ref = "HEAD")` (checkpoint, else legacy commit's graph tree, else `EMPTY_TREE`), `snapshotAtTree(repo, tree)`.

- [ ] **Step 1: Create the package**

`packages/reconcile/package.json`:

```json
{
  "name": "@zarg/reconcile",
  "dependencies": {
    "@effect/platform-bun": "^4.0.0-rc.117",
    "@effect/sql-sqlite-bun": "4.0.0-rc.117",
    "@zarg/graph": "workspace:*",
    "effect": "^4.0.0-rc.117"
  },
  "exports": {
    ".": "./src/index.ts"
  },
  "private": true,
  "type": "module"
}
```

`packages/reconcile/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/reconcile/mise.toml`:

```toml
[tasks.typecheck]
run = "mise x -- bunx tsc"

[tasks.test]
run = "mise x -- bun test"
```

Run: `mise x -- bun install`
Expected: `@effect/sql-sqlite-bun` 4.0.0-rc.117 installed; `bun.lock` changes.

- [ ] **Step 2: Write the failing test**

`packages/reconcile/test/repo.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** Run a shell command in `cwd`; throws with its output when it fails. */
export const sh = (cwd: string, cmd: string) => {
  const p = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}${p.stdout.toString()}`)
  return p.stdout.toString().trim()
}

export const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

const roots: Array<string> = []
export const cleanup = () => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }))

/** A git repo on branch `main` with one commit. */
export const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "zarg-reconcile-"))
  roots.push(root)
  sh(root, "git init -q -b main && git config user.email t@t && git config user.name t")
  write(root, "README.md", "hello\n")
  sh(root, "git add -A && git commit -qm init")
  return root
}

export const state = (id: string, text: string) => ({ id, type: "gherkin/state", props: { text }, edges: [] })
export const card = (id: string, arrives: string, then: string, when = "the user acts") => ({
  id,
  type: "gherkin/card",
  props: { title: id, when },
  edges: [{ type: "gherkin/arrives", to: arrives }, { type: "gherkin/then", to: then }],
})
export const writeNode = (root: string, node: { id: string }) => write(root, `.zarg/graph/nodes/${node.id}.json`, `${JSON.stringify(node)}\n`)
```

`packages/reconcile/test/checkpoint.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { baseTree, EMPTY_TREE, snapshotAtTree, workingGraphTree } from "../src"
import { card, cleanup, repo, sh, state, write, writeNode } from "./repo"

afterAll(cleanup)
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

describe("checkpoint", () => {
  test("the working graph tree includes uncommitted files and leaves the real index alone", async () => {
    const r = repo()
    expect(await run(workingGraphTree(r))).toBe(EMPTY_TREE)
    writeNode(r, state("S-0001", "home"))
    const before = sh(r, "git status --porcelain")
    const tree = await run(workingGraphTree(r))
    expect(tree).not.toBe(EMPTY_TREE)
    expect(sh(r, "git status --porcelain")).toBe(before)
    sh(r, "git add -A && git commit -qm graph")
    expect(sh(r, "git rev-parse HEAD:.zarg/graph")).toBe(tree)
  })

  test("snapshotAtTree reads the nodes stored in a tree", async () => {
    const r = repo()
    writeNode(r, state("S-0001", "home"))
    writeNode(r, card("UX-0001", "S-0001", "S-0001"))
    const snap = await run(Effect.flatMap(workingGraphTree(r), (t) => snapshotAtTree(r, t)))
    expect([...snap.nodes.keys()].sort()).toEqual(["S-0001", "UX-0001"])
  })

  test("the base is the committed checkpoint, else the legacy sync.json commit, else empty", async () => {
    const r = repo()
    expect(await run(baseTree(r))).toBe(EMPTY_TREE)
    writeNode(r, state("S-0001", "home"))
    sh(r, "git add -A && git commit -qm graph")
    const graphCommit = sh(r, "git rev-parse HEAD")
    const graphTree = sh(r, "git rev-parse HEAD:.zarg/graph")
    write(r, ".zarg/sync.json", JSON.stringify({ graph: graphCommit }))
    sh(r, "git add -A && git commit -qm legacy")
    expect(await run(baseTree(r))).toBe(graphTree)
    write(r, ".zarg/reconciled.json", JSON.stringify({ graph: EMPTY_TREE }))
    sh(r, "git add -A && git commit -qm checkpoint")
    expect(await run(baseTree(r))).toBe(EMPTY_TREE)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/reconcile && mise x -- bun test`
Expected: FAIL (`../src` does not exist).

- [ ] **Step 4: Implement**

`packages/reconcile/src/git.ts`:

```ts
import { Data, Effect } from "effect"

export class GitError extends Data.TaggedError("GitError")<{ readonly args: ReadonlyArray<string>; readonly message: string }> {}

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run git in `cwd`; never fails on a non-zero exit (callers that expect conflicts read the code). */
export const gitRun = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}): Effect.Effect<GitResult> =>
  Effect.promise(async () => {
    const p = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, stdout, stderr }
  })

/** Run git in `cwd`; a non-zero exit is a GitError. Returns stdout without the trailing newline. */
export const git = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}): Effect.Effect<string, GitError> =>
  Effect.flatMap(gitRun(cwd, args, env), (r) =>
    r.code === 0 ? Effect.succeed(r.stdout.replace(/\n$/, "")) : Effect.fail(new GitError({ args, message: (r.stderr || r.stdout).trim() })),
  )

/** git's well-known empty tree. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
```

`packages/reconcile/src/checkpoint.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { Node, Snapshot } from "@zarg/graph"
import { EMPTY_TREE, git, gitRun } from "./git"

export const GRAPH = ".zarg/graph"
export const CHECKPOINT = ".zarg/reconciled.json"
/** Phase 1's checkpoint: `{ "graph": "<commit sha>" }`. Read once as the base, removed by the first commit. */
export const LEGACY_CHECKPOINT = ".zarg/sync.json"

/**
 * The git tree id of the working `.zarg/graph`, including uncommitted and untracked files. Built in a
 * throwaway index, so the repository's own index is untouched.
 */
export const workingGraphTree = (repo: string) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "zarg-index-"))
    const env = { GIT_INDEX_FILE: join(dir, "index") }
    try {
      yield* git(repo, ["read-tree", "--empty"], env)
      if (!existsSync(join(repo, GRAPH))) return EMPTY_TREE
      yield* git(repo, ["add", "-A", "--", GRAPH], env)
      const listed = yield* git(repo, ["ls-files", "--", GRAPH], env)
      if (listed === "") return EMPTY_TREE
      return yield* git(repo, ["write-tree", `--prefix=${GRAPH}/`], env)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

const readAt = (repo: string, ref: string, path: string) =>
  Effect.map(gitRun(repo, ["show", `${ref}:${path}`]), (r) => (r.code === 0 ? r.stdout : undefined))

/** The graph tree the last landed pass reconciled, from HEAD (or the legacy checkpoint, or nothing yet). */
export const baseTree = (repo: string, ref = "HEAD") =>
  Effect.gen(function* () {
    const current = yield* readAt(repo, ref, CHECKPOINT)
    if (current !== undefined) return (JSON.parse(current) as { graph: string }).graph
    const legacy = yield* readAt(repo, ref, LEGACY_CHECKPOINT)
    if (legacy !== undefined) {
      const commit = (JSON.parse(legacy) as { graph: string }).graph
      const tree = yield* gitRun(repo, ["rev-parse", `${commit}:${GRAPH}`])
      if (tree.code === 0) return tree.stdout.trim()
    }
    return EMPTY_TREE
  })

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Node))

/** The graph stored in git as tree `tree` (the contents of `.zarg/graph`). Undecodable nodes are skipped. */
export const snapshotAtTree = (repo: string, tree: string) =>
  Effect.gen(function* () {
    if (tree === EMPTY_TREE) return Snapshot.make([])
    const listing = yield* git(repo, ["ls-tree", "-r", "--name-only", tree, "--", "nodes"])
    const files = listing.split("\n").filter((f) => f.endsWith(".json"))
    const nodes = yield* Effect.forEach(files, (f) =>
      Effect.flatMap(git(repo, ["show", `${tree}:${f}`]), (text) => Effect.option(decode(text))),
    )
    return Snapshot.make(nodes.flatMap((n) => (n._tag === "Some" ? [n.value] : [])))
  })
```

`packages/reconcile/src/index.ts` (later tasks add lines):

```ts
export * from "./checkpoint"
export * from "./git"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/reconcile && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
mise run verify
git add packages/reconcile bun.lock
git commit -m "feat(reconcile): git plumbing and the graph checkpoint"
```

---

### Task 3: Worktrees and merging card branches

**Files:**
- Create: `packages/reconcile/src/worktree.ts`, `packages/reconcile/src/merge.ts`
- Modify: `packages/reconcile/src/index.ts`
- Test: `packages/reconcile/test/worktree.test.ts`

**Interfaces:**
- Consumes: `git`, `gitRun` (Task 2).
- Produces: `worktreeRoot(repo)` (`.zarg/reconcile/wt`), `ensureWorktree(repo, path, branch, base)` (create or reset; keeps ignored files), `removeWorktree(repo, path, branch)`, `gcPasses(repo, keep, branchOf)`; `Conflict { branch, files }`, `mergeBranches(cwd, branches, resolve: (Conflict) => Effect<boolean>) → { merged, failed: Conflict[] }` (a resolution that leaves `<<<<<<<` markers counts as failed).

- [ ] **Step 1: Write the failing test**

`packages/reconcile/test/worktree.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { ensureWorktree, mergeBranches, removeWorktree, worktreeRoot } from "../src"
import { cleanup, repo, sh, write } from "./repo"

afterAll(cleanup)
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

describe("worktrees", () => {
  test("ensure creates, then resets an existing worktree to its base; the repo never sees it", async () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    const wt = join(worktreeRoot(r), "p1", "main")
    await run(ensureWorktree(r, wt, "zarg/p1/main", base))
    write(wt, "README.md", "changed\n")
    write(wt, "junk.txt", "x")
    await run(ensureWorktree(r, wt, "zarg/p1/main", base))
    expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("hello\n")
    expect(existsSync(join(wt, "junk.txt"))).toBe(false)
    expect(sh(r, "git status --porcelain")).toBe("")
    await run(removeWorktree(r, wt, "zarg/p1/main"))
    expect(existsSync(wt)).toBe(false)
    expect(sh(r, "git branch --list 'zarg/*'")).toBe("")
  })
})

describe("mergeBranches", () => {
  const setup = () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    const make = async (name: string, file: string, text: string) => {
      const wt = join(worktreeRoot(r), "p", name)
      await run(ensureWorktree(r, wt, `zarg/p/${name}`, base))
      write(wt, file, text)
      sh(wt, `git add -A && git commit -qm ${name}`)
    }
    return { r, base, make }
  }

  test("independent branches merge cleanly", async () => {
    const { r, base, make } = setup()
    await make("a", "a.ts", "a\n")
    await make("b", "b.ts", "b\n")
    const main = join(worktreeRoot(r), "p", "main")
    await run(ensureWorktree(r, main, "zarg/p/main", base))
    const out = await run(mergeBranches(main, ["zarg/p/a", "zarg/p/b"], () => Effect.succeed(false)))
    expect(out).toEqual({ merged: ["zarg/p/a", "zarg/p/b"], failed: [] })
    expect(existsSync(join(main, "a.ts")) && existsSync(join(main, "b.ts"))).toBe(true)
  })

  test("a conflict the resolver fixes is committed; one it cannot fix is aborted and reported", async () => {
    const { r, base, make } = setup()
    await make("a", "README.md", "from a\n")
    await make("b", "README.md", "from b\n")
    await make("c", "README.md", "from c\n")
    const main = join(worktreeRoot(r), "p", "main")
    await run(ensureWorktree(r, main, "zarg/p/main", base))
    const seen: Array<string> = []
    const out = await run(
      mergeBranches(main, ["zarg/p/a", "zarg/p/b", "zarg/p/c"], (c) =>
        Effect.sync(() => {
          seen.push(`${c.branch}:${c.files.join(",")}`)
          if (c.branch === "zarg/p/b") writeFileSync(join(main, "README.md"), "from a and b\n")
          return c.branch === "zarg/p/b"
        }),
      ),
    )
    expect(seen).toEqual(["zarg/p/b:README.md", "zarg/p/c:README.md"])
    expect(out.merged).toEqual(["zarg/p/a", "zarg/p/b"])
    expect(out.failed).toEqual([{ branch: "zarg/p/c", files: ["README.md"] }])
    expect(readFileSync(join(main, "README.md"), "utf8")).toBe("from a and b\n")
    expect(sh(main, "git status --porcelain")).toBe("")
  })

  test("a resolver that claims success but leaves conflict markers is treated as a failure", async () => {
    const { r, base, make } = setup()
    await make("a", "README.md", "from a\n")
    await make("b", "README.md", "from b\n")
    const main = join(worktreeRoot(r), "p", "main")
    await run(ensureWorktree(r, main, "zarg/p/main", base))
    const out = await run(mergeBranches(main, ["zarg/p/a", "zarg/p/b"], () => Effect.succeed(true)))
    expect(out.failed.map((c) => c.branch)).toEqual(["zarg/p/b"])
    expect(readFileSync(join(main, "README.md"), "utf8")).toBe("from a\n")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/reconcile && mise x -- bun test test/worktree.test.ts`
Expected: FAIL (`ensureWorktree` is not exported).

- [ ] **Step 3: Implement**

`packages/reconcile/src/worktree.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { git, gitRun } from "./git"

/** Where passes keep their worktrees. A `*` .gitignore inside keeps them out of the repository. */
export const worktreeRoot = (repo: string) => join(repo, ".zarg", "reconcile", "wt")

const ensureIgnored = (repo: string) => {
  const dir = join(repo, ".zarg", "reconcile")
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n")
}

/**
 * A worktree at `path` on `branch`, reset to `base`. Idempotent: an existing worktree is reset
 * (tracked changes discarded, untracked files removed, ignored files such as node_modules kept).
 */
export const ensureWorktree = (repo: string, path: string, branch: string, base: string) =>
  Effect.gen(function* () {
    ensureIgnored(repo)
    if (existsSync(join(path, ".git"))) {
      yield* git(path, ["checkout", "-q", "-B", branch, base])
      yield* git(path, ["reset", "-q", "--hard", base])
      yield* git(path, ["clean", "-q", "-fd"])
    } else {
      mkdirSync(join(path, ".."), { recursive: true })
      yield* git(repo, ["worktree", "add", "-q", "-B", branch, path, base])
    }
    return path
  })

/** Remove a worktree and its branch; missing ones are fine. */
export const removeWorktree = (repo: string, path: string, branch: string) =>
  Effect.gen(function* () {
    yield* gitRun(repo, ["worktree", "remove", "--force", path])
    yield* gitRun(repo, ["branch", "-q", "-D", branch])
    yield* gitRun(repo, ["worktree", "prune"])
  })

/** Remove all but the newest `keep` pass directories under the worktree root (failed passes kept for inspection). */
export const gcPasses = (repo: string, keep: number, branchOf: (pass: string, name: string) => string) =>
  Effect.gen(function* () {
    const root = worktreeRoot(repo)
    if (!existsSync(root)) return
    const passes = readdirSync(root)
      .map((p) => ({ p, t: statSync(join(root, p)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(keep)
    for (const { p } of passes) {
      for (const name of readdirSync(join(root, p))) yield* removeWorktree(repo, join(root, p, name), branchOf(p, name))
      yield* Effect.sync(() => Bun.spawnSync(["rm", "-rf", join(root, p)]))
    }
  })
```

`packages/reconcile/src/merge.ts`:

```ts
import { Effect } from "effect"
import { git, gitRun } from "./git"

export interface Conflict {
  readonly branch: string
  readonly files: ReadonlyArray<string>
}

/**
 * Merge `branches` one by one into the branch checked out at `cwd`. On a conflict, `resolve` gets the
 * conflicted files to fix in place; it answers true when they are resolved (the merge is then committed)
 * or false (the merge is aborted and the branch reported). Returns the merged branches and the conflicts
 * that could not be resolved.
 */
export const mergeBranches = <E, R>(cwd: string, branches: ReadonlyArray<string>, resolve: (c: Conflict) => Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    const merged: Array<string> = []
    const failed: Array<Conflict> = []
    for (const branch of branches) {
      const r = yield* gitRun(cwd, ["merge", "--no-ff", "--no-edit", "-q", branch])
      if (r.code === 0) {
        merged.push(branch)
        continue
      }
      const files = (yield* git(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter((f) => f.length > 0)
      const conflict = { branch, files }
      const ok = files.length > 0 && (yield* resolve(conflict))
      const markers = ok ? (yield* gitRun(cwd, ["grep", "-l", "-e", "^<<<<<<< ", "--", ...files])).stdout.trim() : ""
      if (ok && markers === "") {
        yield* git(cwd, ["add", "-A"])
        yield* git(cwd, ["commit", "-q", "--no-edit"])
        merged.push(branch)
      } else {
        yield* gitRun(cwd, ["merge", "--abort"])
        failed.push(conflict)
      }
    }
    return { merged, failed }
  })
```

Append to `packages/reconcile/src/index.ts`:

```ts
export * from "./merge"
export * from "./worktree"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/reconcile && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/reconcile
git commit -m "feat(reconcile): worktrees per pass and card, merging card branches"
```

---

### Task 4: Landing on your branch

**Files:**
- Create: `packages/reconcile/src/land.ts`
- Modify: `packages/reconcile/src/index.ts`
- Test: `packages/reconcile/test/land.test.ts`

**Interfaces:**
- Consumes: `git`, `gitRun`, `GRAPH` (Task 2); `ensureWorktree`, `worktreeRoot` (Task 3).
- Produces: `LandResult = landed | moved {head} | waiting {paths} | refused {reason}`; `checkoutProblem(repo) → string | undefined`; `land(repo, commit, base): Effect<LandResult>` (idempotent fast-forward); `rebaseOnto(cwd, onto, resolve: (files) => Effect<boolean>) → { ok: true } | { ok: false; files }`.

- [ ] **Step 1: Write the failing test**

`packages/reconcile/test/land.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { ensureWorktree, land, rebaseOnto, worktreeRoot } from "../src"
import { card, cleanup, repo, sh, state, write, writeNode } from "./repo"

afterAll(cleanup)
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

/** A repo whose driver wrote S-0001 and UX-0001 (uncommitted), and a pass commit with those cards plus code. */
const passCommit = async () => {
  const r = repo()
  const base = sh(r, "git rev-parse HEAD")
  writeNode(r, state("S-0001", "home"))
  writeNode(r, card("UX-0001", "S-0001", "S-0001"))
  const wt = join(worktreeRoot(r), "p", "main")
  await run(ensureWorktree(r, wt, "zarg/p/main", base))
  writeNode(wt, state("S-0001", "home"))
  writeNode(wt, card("UX-0001", "S-0001", "S-0001"))
  write(wt, "src/home.ts", "export const home = 1\n")
  sh(wt, "git add -A && git commit -qm 'feat: implement UX-0001'")
  return { r, base, wt, commit: sh(wt, "git rev-parse HEAD") }
}

describe("land", () => {
  test("fast-forwards; the driver's identical uncommitted cards end up clean; landing again is a no-op", async () => {
    const { r, base, commit } = await passCommit()
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
    expect(sh(r, "git rev-parse HEAD")).toBe(commit)
    expect(sh(r, "git status --porcelain")).toBe("")
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
  })

  test("your edits in other files stay; edits in a file the commit changes make it wait", async () => {
    const { r, base, commit } = await passCommit()
    write(r, "README.md", "mine\n")
    write(r, "src/home.ts", "my version\n")
    expect(await run(land(r, commit, base))).toEqual({ status: "waiting", paths: ["src/home.ts"] })
    expect(sh(r, "git rev-parse HEAD")).toBe(base)
    sh(r, "rm src/home.ts")
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
    expect(readFileSync(join(r, "README.md"), "utf8")).toBe("mine\n")
  })

  test("a card the driver edited again keeps its newer content after landing", async () => {
    const { r, base, commit } = await passCommit()
    writeNode(r, card("UX-0001", "S-0001", "S-0001", "the user taps twice"))
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
    expect(readFileSync(join(r, ".zarg/graph/nodes/UX-0001.json"), "utf8")).toContain("taps twice")
    expect(sh(r, "git status --porcelain")).toBe("M .zarg/graph/nodes/UX-0001.json")
  })

  test("a card the driver removed during the pass stays removed", async () => {
    const { r, base, commit } = await passCommit()
    sh(r, "rm .zarg/graph/nodes/UX-0001.json")
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
    expect(existsSync(join(r, ".zarg/graph/nodes/UX-0001.json"))).toBe(false)
  })

  test("a moved branch is reported; after a rebase the commit lands", async () => {
    const { r, base, wt } = await passCommit()
    sh(r, "rm -rf .zarg/graph")
    write(r, "notes.md", "yours\n")
    sh(r, "git add -A && git commit -qm yours")
    const head = sh(r, "git rev-parse HEAD")
    const moved = await run(land(r, sh(wt, "git rev-parse HEAD"), base))
    expect(moved).toEqual({ status: "moved", head })
    expect(await run(rebaseOnto(wt, head, () => Effect.succeed(false)))).toEqual({ ok: true })
    expect(await run(land(r, sh(wt, "git rev-parse HEAD"), head))).toEqual({ status: "landed" })
    expect(readFileSync(join(r, "notes.md"), "utf8")).toBe("yours\n")
    expect(existsSync(join(r, "src/home.ts"))).toBe(true)
  })

  test("a detached HEAD or a merge in progress refuses to land", async () => {
    const { r, base, commit } = await passCommit()
    sh(r, "git checkout -q --detach")
    expect((await run(land(r, commit, base))).status).toBe("refused")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/reconcile && mise x -- bun test test/land.test.ts`
Expected: FAIL (`land` is not exported).

- [ ] **Step 3: Implement**

`packages/reconcile/src/land.ts`:

```ts
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { GRAPH } from "./checkpoint"
import { git, gitRun } from "./git"

export type LandResult =
  | { readonly status: "landed" }
  /** The branch moved since the pass started: rebase onto `head`, verify again, land again. */
  | { readonly status: "moved"; readonly head: string }
  /** Uncommitted edits in paths the commit changes: try again later. */
  | { readonly status: "waiting"; readonly paths: ReadonlyArray<string> }
  /** The checkout cannot take a commit now (detached HEAD, a merge or rebase in progress). */
  | { readonly status: "refused"; readonly reason: string }

const statusPaths = (repo: string) =>
  Effect.map(git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), (out) => {
    const paths: Array<string> = []
    const parts = out.split("\0").filter((p) => p.length > 0)
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!
      paths.push(entry.slice(3))
      if (entry[0] === "R" || entry[0] === "C") i++ // the rename's source path follows
    }
    return paths
  })

/** Why the checkout at `repo` cannot land a commit right now, if it cannot. */
export const checkoutProblem = (repo: string) =>
  Effect.gen(function* () {
    const branch = yield* gitRun(repo, ["symbolic-ref", "-q", "--short", "HEAD"])
    if (branch.code !== 0) return "HEAD is detached; check out a branch"
    const gitDir = yield* git(repo, ["rev-parse", "--absolute-git-dir"])
    for (const [f, what] of [["MERGE_HEAD", "a merge"], ["rebase-merge", "a rebase"], ["rebase-apply", "a rebase"], ["CHERRY_PICK_HEAD", "a cherry-pick"]] as const) {
      if (existsSync(join(gitDir, f))) return `${what} is in progress; finish or abort it`
    }
    return undefined
  })

/**
 * Fast-forward the checked-out branch at `repo` from `base` to `commit`. Your uncommitted edits in other
 * paths stay. Graph files the driver has not committed are moved out of the way and put back: identical
 * ones simply match the commit, newer ones keep their newer content (the next pass reconciles them).
 * Idempotent: a commit already on the branch counts as landed.
 */
export const land = (repo: string, commit: string, base: string) =>
  Effect.gen(function* () {
    const problem = yield* checkoutProblem(repo)
    if (problem !== undefined) return { status: "refused", reason: problem } satisfies LandResult
    if ((yield* gitRun(repo, ["merge-base", "--is-ancestor", commit, "HEAD"])).code === 0) return { status: "landed" } satisfies LandResult
    const head = yield* git(repo, ["rev-parse", "HEAD"])
    if (head !== base) return { status: "moved", head } satisfies LandResult

    const touched = new Set((yield* git(repo, ["diff", "--name-only", base, commit])).split("\n").filter((p) => p.length > 0))
    const dirty = (yield* statusPaths(repo)).filter((p) => touched.has(p))
    const blocked = dirty.filter((p) => !p.startsWith(`${GRAPH}/`))
    if (blocked.length > 0) return { status: "waiting", paths: blocked } satisfies LandResult

    // Graph files the commit touches: remember their working content (or absence), even when unchanged
    // since HEAD, since the driver may have edited or removed a card after the pass read it. Dirty ones are
    // made to match HEAD so the fast-forward can proceed; afterwards every path gets its working state back.
    const saved = new Map<string, string | undefined>()
    for (const p of [...touched].filter((p) => p.startsWith(`${GRAPH}/`))) {
      const abs = join(repo, p)
      saved.set(p, existsSync(abs) ? readFileSync(abs, "utf8") : undefined)
    }
    for (const p of dirty) {
      if ((yield* gitRun(repo, ["cat-file", "-e", `HEAD:${p}`])).code === 0) yield* git(repo, ["checkout", "-q", "HEAD", "--", p])
      else rmSync(join(repo, p), { force: true })
    }
    yield* git(repo, ["merge", "--ff-only", "-q", commit])
    for (const [p, content] of saved) {
      const landed = yield* gitRun(repo, ["show", `${commit}:${p}`])
      const committed = landed.code === 0 ? landed.stdout : undefined
      if (content === committed) continue
      if (content === undefined) rmSync(join(repo, p), { force: true })
      else writeFileSync(join(repo, p), content)
    }
    return { status: "landed" } satisfies LandResult
  })

/**
 * Rebase the pass branch at `cwd` onto `onto`. Conflicts go to `resolve` (fix the files in place, answer
 * true); an unresolved conflict aborts the rebase and is reported.
 */
export const rebaseOnto = <E, R>(cwd: string, onto: string, resolve: (files: ReadonlyArray<string>) => Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    let r = yield* gitRun(cwd, ["rebase", "-q", onto])
    while (r.code !== 0) {
      const files = (yield* git(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter((f) => f.length > 0)
      const ok = files.length > 0 && (yield* resolve(files))
      const markers = ok ? (yield* gitRun(cwd, ["grep", "-l", "-e", "^<<<<<<< ", "--", ...files])).stdout.trim() : "x"
      if (markers !== "") {
        yield* gitRun(cwd, ["rebase", "--abort"])
        return { ok: false, files } as const
      }
      yield* git(cwd, ["add", "-A"])
      r = yield* gitRun(cwd, ["-c", "core.editor=true", "rebase", "--continue"])
    }
    return { ok: true } as const
  })
```

Append to `packages/reconcile/src/index.ts`:

```ts
export * from "./land"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/reconcile && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/reconcile
git commit -m "feat(reconcile): land by fast-forward, keeping your edits and the driver's newer cards"
```

---

### Task 5: Findings

**Files:**
- Create: `packages/reconcile/src/findings.ts`
- Modify: `packages/reconcile/src/index.ts`
- Test: `packages/reconcile/test/findings.test.ts`

**Interfaces:**
- Produces: `FindingKind` (`unplannable | blocked-card | merge-conflict | verify-failing | landing-blocked | pass-error`), `Finding { id, kind, title, detail, about, pass, at }`, `NewFinding`, `findingsPath(repo)`, `makeFindings(repo) → Findings { list(), raise(NewFinding): Finding, clearFor(cards): number }`.

- [ ] **Step 1: Write the failing test**

`packages/reconcile/test/findings.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { makeFindings } from "../src"
import { cleanup, repo } from "./repo"

afterAll(cleanup)

describe("findings", () => {
  test("raise, replace the same kind about the same cards, clear by card, survive a reopen", () => {
    const r = repo()
    const f = makeFindings(r)
    f.raise({ kind: "blocked-card", title: "UX-1 contradicts UX-2", detail: "d1", about: ["UX-1", "UX-2"], pass: "p1" })
    f.raise({ kind: "verify-failing", title: "verify fails", detail: "d", about: ["UX-3"], pass: "p1" })
    f.raise({ kind: "blocked-card", title: "still", detail: "d2", about: ["UX-2", "UX-1"], pass: "p2" })
    expect(makeFindings(r).list().map((x) => [x.kind, x.detail])).toEqual([["verify-failing", "d"], ["blocked-card", "d2"]])
    expect(f.clearFor(["UX-2"])).toBe(1)
    expect(f.list().map((x) => x.kind)).toEqual(["verify-failing"])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/reconcile && mise x -- bun test test/findings.test.ts`
Expected: FAIL (`makeFindings` is not exported).

- [ ] **Step 3: Implement**

`packages/reconcile/src/findings.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type FindingKind = "unplannable" | "blocked-card" | "merge-conflict" | "verify-failing" | "landing-blocked" | "pass-error"

/** Something a phase could not project; it reaches the developer through the driver's agenda. */
export interface Finding {
  readonly id: string
  readonly kind: FindingKind
  readonly title: string
  readonly detail: string
  /** The cards it concerns. */
  readonly about: ReadonlyArray<string>
  readonly pass: string
  readonly at: string
}

export type NewFinding = Omit<Finding, "id" | "at">

export const findingsPath = (repo: string) => join(repo, ".zarg", "reconcile", "findings.json")

/**
 * Open findings, kept in `.zarg/reconcile/findings.json` (gitignored; survives restarts). A new finding of
 * the same kind about the same cards replaces the old one.
 */
export const makeFindings = (repo: string) => {
  const file = findingsPath(repo)
  const read = (): ReadonlyArray<Finding> => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ReadonlyArray<Finding>) : [])
  const write = (all: ReadonlyArray<Finding>) => {
    mkdirSync(dirname(file), { recursive: true })
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
    /** Close every finding about any of these cards (they landed, or the driver changed them). */
    clearFor: (cards: ReadonlyArray<string>) => {
      const set = new Set(cards)
      const all = read()
      const kept = all.filter((f) => !f.about.some((c) => set.has(c)))
      if (kept.length !== all.length) write(kept)
      return all.length - kept.length
    },
  }
}

export type Findings = ReturnType<typeof makeFindings>
```

Append to `packages/reconcile/src/index.ts`:

```ts
export * from "./findings"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/reconcile && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/reconcile
git commit -m "feat(reconcile): findings store"
```

---

### Task 6: The durable pass

**Files:**
- Create: `packages/reconcile/src/pass.ts`, `packages/reconcile/src/engine.ts`
- Modify: `packages/reconcile/src/index.ts`
- Test: `packages/reconcile/test/stub-spec.ts` (stub phases), `packages/reconcile/test/pass.test.ts`, `packages/reconcile/test/resume-fixture.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: `ItemOutcome`, `Phase { name, isolated, run(item, cwd) }`, `ReconcileSpec { repo, phases, affected, setup?, onRemoved?, verify, fix, resolve, findings, maxParallel, fixAttempts, landRetry, landAttempts, message, withGraphLock? }`, `PassResult { status: nothing | landed | failed, commit?, landed, failed }`, `Pass` (the Workflow: payload `{ graph, branch, base }`, idempotency key `graph:branch@base`), `passLayer(spec)`; `engineLayer(file)` (SingleRunner + ClusterWorkflowEngine on `bun:sqlite`).

- [ ] **Step 1: Write the failing tests**

`packages/reconcile/test/stub-spec.ts`:

```ts
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { canonical } from "@zarg/graph"
import { engineLayer, makeFindings, Pass, passLayer, type ReconcileSpec, workingGraphTree } from "../src"
import { sh, write } from "./repo"

/** Stub phases: plan writes .zarg/plans/<card>.md; implement writes src/<card>.ts (or what `code` says). */
export const stubSpec = (repo: string, opts: {
  blocked?: ReadonlyArray<string>
  code?: Record<string, { file: string; text: string }>
  brokenFixes?: number
  resolve?: (cwd: string, files: ReadonlyArray<string>) => boolean
  landAttempts?: number
  /** Called when an item is implemented (e.g. to commit on the developer's branch meanwhile). */
  during?: (item: string) => void
  /** Record calls in this file too (for tests that span processes). */
  callLog?: string
} = {}): ReconcileSpec & { calls: Array<string> } => {
  const calls: Array<string> = []
  let fixes = 0
  return {
    calls,
    repo,
    affected: (before, after) => {
      const items = [...after.nodes.values()].filter((n) => n.type === "gherkin/card" && (!before.nodes.has(n.id) || canonical(before.nodes.get(n.id)!) !== canonical(n))).map((n) => n.id)
      const removed = [...before.nodes.keys()].filter((id) => !after.nodes.has(id) && id.startsWith("UX-"))
      return { items: items.sort(), removed }
    },
    phases: [
      {
        name: "plan",
        isolated: false,
        run: (item, cwd) =>
          Effect.sync(() => {
            calls.push(`plan ${item}`)
            if (opts.callLog) appendFileSync(opts.callLog, `plan ${item}\n`)
            write(cwd, `.zarg/plans/${item}.md`, `# ${item}\n`)
            return { ok: true } as const
          }),
      },
      {
        name: "implement",
        isolated: true,
        run: (item, cwd) =>
          Effect.sync(() => {
            calls.push(`implement ${item}`)
            if (opts.callLog) appendFileSync(opts.callLog, `implement ${item}\n`)
            opts.during?.(item)
            if (opts.blocked?.includes(item)) return { ok: false, kind: "blocked-card", title: `${item} contradicts another card`, detail: "stub" } as const
            if (!existsSync(join(cwd, `.zarg/plans/${item}.md`))) return { ok: false, kind: "blocked-card", title: "no plan", detail: "" } as const
            const c = opts.code?.[item] ?? { file: `src/${item}.ts`, text: `// @card ${item}\nexport const ok = true\n` }
            write(cwd, c.file, c.text)
            return { ok: true } as const
          }),
      },
    ],
    onRemoved: (items, cwd) => Effect.sync(() => items.forEach((i) => sh(cwd, `rm -f .zarg/plans/${i}.md src/${i}.ts`))),
    verify: (cwd) =>
      Effect.sync(() => {
        calls.push("verify")
        const src = join(cwd, "src")
        const broken = existsSync(src) && readdirSync(src).some((f) => readFileSync(join(src, f), "utf8").includes("BROKEN"))
        return { passed: !broken, output: broken ? "src contains BROKEN" : "ok" }
      }),
    fix: (cwd) =>
      Effect.sync(() => {
        calls.push("fix")
        if (fixes++ < (opts.brokenFixes ?? 0)) return
        for (const f of readdirSync(join(cwd, "src"))) writeFileSync(join(cwd, "src", f), readFileSync(join(cwd, "src", f), "utf8").replaceAll("BROKEN", "fixed"))
      }),
    resolve: (cwd, files) => Effect.sync(() => opts.resolve?.(cwd, files) ?? false),
    findings: makeFindings(repo),
    maxParallel: 2,
    fixAttempts: 2,
    landRetry: "50 millis",
    landAttempts: opts.landAttempts ?? 10,
    message: (items) => `feat: implement ${items.join(", ")}`,
  }
}

/** Run one pass for the repo's current working graph. */
export const runPass = (spec: ReconcileSpec, db: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const graph = yield* workingGraphTree(spec.repo)
      const base = sh(spec.repo, "git rev-parse HEAD")
      return yield* Pass.execute({ graph, branch: "main", base })
    }).pipe(Effect.provide(passLayer(spec).pipe(Layer.provideMerge(engineLayer(db))))) as Effect.Effect<typeof Pass.successSchema.Type>,
  )
```

`packages/reconcile/test/resume-fixture.ts`:

```ts
// A pass in its own process: `CRASH_ON=<card>` kills the process while that card is being implemented.
import { runPass, stubSpec } from "./stub-spec"

const [repo, db, log] = process.argv.slice(2) as [string, string, string]
const spec = stubSpec(repo, {
  callLog: log,
  during: (item) => {
    if (process.env.CRASH_ON === item) process.exit(9)
  },
})
const out = await runPass({ ...spec, maxParallel: 1 }, db)
console.log(JSON.stringify(out))
process.exit(0)
```

`packages/reconcile/test/pass.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { card, cleanup, repo, sh, state, write, writeNode } from "./repo"
import { runPass, stubSpec } from "./stub-spec"

afterAll(cleanup)
const db = () => join(mkdtempSync(join(tmpdir(), "zarg-db-")), "cluster.db")
const graph = (r: string, cards: ReadonlyArray<string>) => {
  writeNode(r, state("S-0001", "home"))
  for (const c of cards) writeNode(r, card(c, "S-0001", "S-0001"))
}

describe("reconcile pass", () => {
  test("lands one commit with the graph, plans, code and checkpoint; worktrees are removed", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    const spec = stubSpec(r)
    const out = await runPass(spec, db())
    expect(out).toMatchObject({ status: "landed", landed: ["UX-0001", "UX-0002"], failed: [] })
    expect(sh(r, "git log --format=%s")).toBe("feat: implement UX-0001, UX-0002\ninit")
    expect(sh(r, "git show --name-only --format= HEAD").split("\n").sort()).toEqual([
      ".zarg/graph/nodes/S-0001.json",
      ".zarg/graph/nodes/UX-0001.json",
      ".zarg/graph/nodes/UX-0002.json",
      ".zarg/plans/UX-0001.md",
      ".zarg/plans/UX-0002.md",
      ".zarg/reconciled.json",
      "src/UX-0001.ts",
      "src/UX-0002.ts",
    ])
    expect(JSON.parse(readFileSync(join(r, ".zarg/reconciled.json"), "utf8")).graph).toBe(sh(r, "git rev-parse HEAD:.zarg/graph"))
    expect(sh(r, "git status --porcelain")).toBe("")
    expect(sh(r, "git worktree list").split("\n")).toHaveLength(1)
    expect(sh(r, "git branch --list 'zarg/*'")).toBe("")
  })

  test("a graph with nothing new to reconcile makes no commit", async () => {
    const r = repo()
    graph(r, ["UX-0001"])
    await runPass(stubSpec(r), db())
    const head = sh(r, "git rev-parse HEAD")
    expect(await runPass(stubSpec(r), db())).toMatchObject({ status: "nothing" })
    expect(sh(r, "git rev-parse HEAD")).toBe(head)
  })

  test("a changed card is re-planned and re-implemented; untouched cards are not", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    await runPass(stubSpec(r), db())
    writeNode(r, card("UX-0002", "S-0001", "S-0001", "the user taps twice"))
    const spec = stubSpec(r)
    expect(await runPass(spec, db())).toMatchObject({ status: "landed", landed: ["UX-0002"] })
    expect(spec.calls.filter((c) => c !== "verify")).toEqual(["plan UX-0002", "implement UX-0002"])
  })

  test("a blocked card becomes a finding; the other cards still land; the blocked card has no code", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    const spec = stubSpec(r, { blocked: ["UX-0002"] })
    expect(await runPass(spec, db())).toMatchObject({ status: "landed", landed: ["UX-0001"], failed: ["UX-0002"] })
    expect(existsSync(join(r, "src/UX-0002.ts"))).toBe(false)
    expect(existsSync(join(r, ".zarg/graph/nodes/UX-0002.json"))).toBe(true)
    expect(spec.findings.list().map((f) => [f.kind, f.about])).toEqual([["blocked-card", ["UX-0002"]]])
  })

  test("cards that conflict: an obvious conflict is resolved, a major one becomes a finding", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    const code = { "UX-0001": { file: "src/shared.ts", text: "a\n" }, "UX-0002": { file: "src/shared.ts", text: "b\n" } }
    const major = stubSpec(r, { code })
    expect(await runPass(major, db())).toMatchObject({ status: "landed", landed: ["UX-0001"], failed: ["UX-0002"] })
    expect(major.findings.list().map((f) => f.kind)).toEqual(["merge-conflict"])

    const r2 = repo()
    graph(r2, ["UX-0001", "UX-0002"])
    const obvious = stubSpec(r2, { code, resolve: (cwd) => (write(cwd, "src/shared.ts", "a\nb\n"), true) })
    expect(await runPass(obvious, db())).toMatchObject({ status: "landed", landed: ["UX-0001", "UX-0002"] })
    expect(readFileSync(join(r2, "src/shared.ts"), "utf8")).toBe("a\nb\n")
  })

  test("verify still failing after two fixes: a finding, nothing lands, the pass worktree is kept", async () => {
    const r = repo()
    graph(r, ["UX-0001"])
    const spec = stubSpec(r, { code: { "UX-0001": { file: "src/x.ts", text: "BROKEN\n" } }, brokenFixes: 2 })
    const head = sh(r, "git rev-parse HEAD")
    expect(await runPass(spec, db())).toMatchObject({ status: "failed", failed: ["UX-0001"] })
    expect(spec.calls.filter((c) => c === "fix")).toHaveLength(2)
    expect(sh(r, "git rev-parse HEAD")).toBe(head)
    expect(spec.findings.list().map((f) => f.kind)).toEqual(["verify-failing"])
    expect(sh(r, "git worktree list").split("\n").length).toBeGreaterThan(1)

    const r2 = repo()
    graph(r2, ["UX-0001"])
    const fixed = stubSpec(r2, { code: { "UX-0001": { file: "src/x.ts", text: "BROKEN\n" } }, brokenFixes: 1 })
    expect(await runPass(fixed, db())).toMatchObject({ status: "landed" })
    expect(readFileSync(join(r2, "src/x.ts"), "utf8")).toBe("fixed\n")
  })

  test("your uncommitted edits in a file it changes: landing waits, then gives up with a finding", async () => {
    const r = repo()
    graph(r, ["UX-0001"])
    write(r, "src/UX-0001.ts", "mine\n")
    const spec = stubSpec(r, { landAttempts: 3 })
    expect(await runPass(spec, db())).toMatchObject({ status: "failed" })
    expect(spec.findings.list().map((f) => [f.kind, f.detail])).toEqual([["landing-blocked", "waiting on your uncommitted edits in src/UX-0001.ts"]])
    expect(readFileSync(join(r, "src/UX-0001.ts"), "utf8")).toBe("mine\n")
  })

  test("your branch moved during the pass: the commit is rebased, verified again and lands on top", async () => {
    const r = repo()
    graph(r, ["UX-0001"])
    let committed = false
    const spec = stubSpec(r, {
      during: () => {
        if (committed) return
        committed = true
        write(r, "notes.md", "yours\n")
        sh(r, "git add notes.md && git commit -qm yours")
      },
    })
    expect(await runPass(spec, db())).toMatchObject({ status: "landed" })
    expect(sh(r, "git log --format=%s")).toBe("feat: implement UX-0001\nyours\ninit")
    expect(spec.calls.filter((c) => c === "verify")).toHaveLength(2)
    expect(sh(r, "git status --porcelain")).toBe("")
  })

  test("a pass killed mid-way resumes after the last finished step", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    const file = db()
    const log = join(r, "..", `calls-${Date.now()}.log`)
    const script = join(import.meta.dir, "resume-fixture.ts")
    const first = Bun.spawnSync([process.execPath, script, r, file, log], { env: { ...process.env, CRASH_ON: "UX-0002" } })
    expect(first.exitCode).toBe(9)
    const second = Bun.spawnSync([process.execPath, script, r, file, log])
    expect(second.stdout.toString()).toContain('"status":"landed"')
    const calls = readFileSync(log, "utf8").trim().split("\n")
    expect(calls.filter((c) => c === "plan UX-0001")).toHaveLength(1)
    expect(calls.filter((c) => c === "implement UX-0001")).toHaveLength(1)
    expect(calls.filter((c) => c === "implement UX-0002")).toHaveLength(2)
    expect(sh(r, "git log --format=%s")).toBe("feat: implement UX-0001, UX-0002\ninit")
  }, 30_000)

  test("a removed card's plan and code are deleted in the next pass", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    await runPass(stubSpec(r), db())
    sh(r, "rm .zarg/graph/nodes/UX-0002.json")
    expect(await runPass(stubSpec(r), db())).toMatchObject({ status: "landed" })
    expect(existsSync(join(r, "src/UX-0002.ts"))).toBe(false)
    expect(existsSync(join(r, ".zarg/plans/UX-0002.md"))).toBe(false)
    expect(sh(r, "git status --porcelain")).toBe("")
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/reconcile && mise x -- bun test test/pass.test.ts`
Expected: FAIL (`Pass`, `passLayer`, `engineLayer` are not exported).

- [ ] **Step 3: Implement**

`packages/reconcile/src/engine.ts`:

```ts
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"

/** Durable workflows on one process, stored in SQLite at `file` (for the core: `.zarg/run/cluster.db`). */
export const engineLayer = (file: string) => {
  mkdirSync(dirname(file), { recursive: true })
  return ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer({ runnerStorage: "memory" })),
    Layer.provide(SqliteClient.layer({ filename: file })),
    Layer.provide(BunServices.layer),
  )
}
```

`packages/reconcile/src/pass.ts`:

```ts
import { rmSync } from "node:fs"
import { join } from "node:path"
import { type Duration, Effect, Schema } from "effect"
import type { Snapshot } from "@zarg/graph"
import { Activity, DurableClock, Workflow } from "effect/unstable/workflow"
import { baseTree, CHECKPOINT, GRAPH, LEGACY_CHECKPOINT, snapshotAtTree } from "./checkpoint"
import type { FindingKind, Findings } from "./findings"
import { git, gitRun } from "./git"
import { land, rebaseOnto } from "./land"
import { mergeBranches } from "./merge"
import { ensureWorktree, removeWorktree, worktreeRoot } from "./worktree"

/** What one phase did for one item. A failure becomes a finding and drops the item from later phases. */
export type ItemOutcome = { readonly ok: true } | { readonly ok: false; readonly kind: FindingKind; readonly title: string; readonly detail: string }

export interface Phase {
  readonly name: string
  /** Each item runs in its own worktree and commits there; the branches are merged afterwards. Otherwise items share the pass worktree. */
  readonly isolated: boolean
  readonly run: (item: string, cwd: string) => Effect.Effect<ItemOutcome>
}

export interface ReconcileSpec {
  /** The repository (your main checkout). */
  readonly repo: string
  readonly phases: ReadonlyArray<Phase>
  /** Items (cards) to reconcile between the base graph and the new one, and items that were removed. */
  readonly affected: (base: Snapshot.Snapshot, current: Snapshot.Snapshot) => { readonly items: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> }
  /** Runs in every new worktree before phases use it (e.g. `bun install`). */
  readonly setup?: (cwd: string) => Effect.Effect<void>
  /** Runs once in the pass worktree for removed items (e.g. delete their plan files). */
  readonly onRemoved?: (items: ReadonlyArray<string>, cwd: string) => Effect.Effect<void>
  readonly verify: (cwd: string) => Effect.Effect<{ readonly passed: boolean; readonly output: string }>
  /** Try to make verify pass (attempt 1, 2, …) by editing files in `cwd`. */
  readonly fix: (cwd: string, output: string, attempt: number) => Effect.Effect<void>
  /** Resolve conflicted files in place; true when resolved. */
  readonly resolve: (cwd: string, files: ReadonlyArray<string>) => Effect.Effect<boolean>
  readonly findings: Findings
  readonly maxParallel: number
  readonly fixAttempts: number
  /** Wait between landing attempts while your edits block it. */
  readonly landRetry: Duration.Input
  /** Landing attempts before a landing-blocked finding (spec: 10, one a minute). */
  readonly landAttempts: number
  readonly message: (items: ReadonlyArray<string>) => string
  /** Hold the graph write lock while landing, so no graph write lands halfway. */
  readonly withGraphLock?: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
}

export const PassResult = Schema.Struct({
  status: Schema.Literals(["nothing", "landed", "failed"]),
  commit: Schema.optionalKey(Schema.String),
  landed: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
})
export type PassResult = typeof PassResult.Type

/** One reconcile pass over one graph state, onto one branch at one base commit. Durable: it resumes after a restart. */
export const Pass = Workflow.make("zarg/ReconcilePass", {
  payload: { graph: Schema.String, branch: Schema.String, base: Schema.String },
  success: PassResult,
  idempotencyKey: (p) => `${p.graph}:${p.branch}@${p.base}`,
})

const Outcome = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), kind: Schema.String, title: Schema.String, detail: Schema.String }),
])
const Strings = Schema.Array(Schema.String)

const commitAll = (cwd: string, message: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["add", "-A"])
    const staged = yield* gitRun(cwd, ["diff", "--cached", "--quiet"])
    if (staged.code !== 0) yield* git(cwd, ["commit", "-q", "-m", message])
    return yield* git(cwd, ["rev-parse", "HEAD"])
  })

/** The workflow implementation for `spec`, as a layer. Every side effect is an Activity; the body replays on resume. */
export const passLayer = (spec: ReconcileSpec) =>
  Pass.toLayer((payload, executionId) =>
    Effect.gen(function* () {
      const id = executionId.slice(0, 12)
      const root = join(worktreeRoot(spec.repo), id)
      const main = join(root, "main")
      const branchOf = (name: string) => `zarg/${id}/${name}`
      const act = <A, I>(name: string, success: Schema.Codec<A, I>, execute: Effect.Effect<A, unknown>) =>
        Activity.make({ name, success, execute: Effect.orDie(execute) as Effect.Effect<A> })

      const scope = yield* act(
        "affected",
        Schema.Struct({ items: Strings, removed: Strings }),
        Effect.gen(function* () {
          const baseGraph = yield* baseTree(spec.repo, payload.base)
          const [before, after] = yield* Effect.all([snapshotAtTree(spec.repo, baseGraph), snapshotAtTree(spec.repo, payload.graph)])
          const affected = spec.affected(before, after)
          // Findings about cards that changed are stale: this pass takes them up again.
          spec.findings.clearFor([...affected.items, ...affected.removed])
          return affected
        }),
      )
      if (scope.items.length === 0 && scope.removed.length === 0) return { status: "nothing", landed: [], failed: [] } satisfies PassResult

      // The pass worktree holds exactly the graph tree this pass reconciles (read from git, so later edits cannot leak in).
      yield* act(
        "worktree",
        Schema.String,
        Effect.gen(function* () {
          yield* ensureWorktree(spec.repo, main, branchOf("main"), payload.base)
          yield* gitRun(main, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", GRAPH])
          rmSync(join(main, GRAPH), { recursive: true, force: true })
          yield* git(main, ["read-tree", `--prefix=${GRAPH}/`, "-u", payload.graph])
          if (spec.setup) yield* spec.setup(main)
          if (spec.onRemoved && scope.removed.length > 0) yield* spec.onRemoved(scope.removed, main)
          return yield* commitAll(main, "wip: graph")
        }),
      )

      const failures = new Map<string, Extract<ItemOutcome, { ok: false }>>()
      let live = [...scope.items]
      for (const phase of spec.phases) {
        const passHead = yield* act(`${phase.name}:head`, Schema.String, git(main, ["rev-parse", "HEAD"]))
        const runItem = (item: string) =>
          act(
            `${phase.name}:${item}`,
            Outcome,
            Effect.gen(function* () {
              if (!phase.isolated) return yield* phase.run(item, main)
              const wt = join(root, item)
              yield* ensureWorktree(spec.repo, wt, branchOf(item), passHead)
              if (spec.setup) yield* spec.setup(wt)
              const out = yield* phase.run(item, wt)
              if (out.ok) yield* commitAll(wt, `${phase.name}: ${item}`)
              return out
            }),
          ).pipe(Effect.map((out) => [item, out as ItemOutcome] as const))
        const outcomes = yield* Effect.all(live.map(runItem), { concurrency: spec.maxParallel })
        for (const [item, out] of outcomes) if (!out.ok) failures.set(item, out)
        live = live.filter((i) => !failures.has(i))
        if (phase.isolated) {
          const conflicts = yield* act(
            `${phase.name}:merge`,
            Strings,
            Effect.map(
              mergeBranches(main, live.map(branchOf), (c) => spec.resolve(main, c.files)),
              (r) => r.failed.map((c) => c.branch),
            ),
          )
          for (const b of conflicts) {
            const item = live.find((i) => branchOf(i) === b)!
            failures.set(item, { ok: false, kind: "merge-conflict", title: `${item} conflicts with other cards in this pass`, detail: `branch ${b} could not be merged` })
          }
          live = live.filter((i) => !failures.has(i))
        } else {
          yield* act(`${phase.name}:commit`, Schema.String, commitAll(main, `${phase.name}: ${live.join(", ")}`))
        }
      }

      const gate = (label: string) =>
        act(
          label,
          Schema.Struct({ passed: Schema.Boolean, output: Schema.String }),
          Effect.gen(function* () {
            let v = yield* spec.verify(main)
            for (let attempt = 1; !v.passed && attempt <= spec.fixAttempts; attempt++) {
              yield* spec.fix(main, v.output, attempt)
              yield* commitAll(main, `fix: attempt ${attempt}`)
              v = yield* spec.verify(main)
            }
            return v
          }),
        )
      const report = (extra: ReadonlyArray<{ kind: FindingKind; title: string; detail: string; about: ReadonlyArray<string> }>) =>
        act(
          `findings:${extra.length}`,
          Schema.Void,
          Effect.sync(() => {
            for (const [item, f] of failures) spec.findings.raise({ kind: f.kind, title: f.title, detail: f.detail, about: [item], pass: id })
            for (const f of extra) spec.findings.raise({ ...f, pass: id })
          }),
        )
      const failed = () => [...failures.keys()].sort()

      const verified = yield* gate("verify")
      if (!verified.passed) {
        yield* report([{ kind: "verify-failing", title: "verify still fails after the fix attempts", detail: verified.output.slice(-4000), about: live }])
        return { status: "failed", landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
      }

      // One commit on top of the base: the whole graph tree, plans and code, and the checkpoint.
      const squash = (base: string, graph: string) =>
        Effect.gen(function* () {
          yield* git(main, ["reset", "-q", "--soft", base])
          yield* Effect.sync(() => Bun.write(join(main, CHECKPOINT), `${JSON.stringify({ graph }, null, 2)}\n`))
          yield* gitRun(main, ["rm", "-q", "--cached", "--ignore-unmatch", LEGACY_CHECKPOINT])
          rmSync(join(main, LEGACY_CHECKPOINT), { force: true })
          return yield* commitAll(main, spec.message(live))
        })
      let commit = yield* act("commit", Schema.String, squash(payload.base, payload.graph))
      let base = payload.base

      for (let attempt = 1; ; attempt++) {
        const lock = spec.withGraphLock ?? (<A, E>(e: Effect.Effect<A, E>) => e)
        const r = yield* act(
          `land:${attempt}`,
          Schema.Struct({ status: Schema.String, head: Schema.optionalKey(Schema.String), paths: Schema.optionalKey(Strings), reason: Schema.optionalKey(Schema.String) }),
          lock(land(spec.repo, commit, base)),
        )
        if (r.status === "landed") break
        if (r.status === "moved") {
          const rebased = yield* act(
            `rebase:${attempt}`,
            Schema.Boolean,
            Effect.map(rebaseOnto(main, r.head!, (files) => spec.resolve(main, files)), (x) => x.ok),
          )
          if (!rebased) {
            yield* report([{ kind: "merge-conflict", title: "this pass conflicts with your new commits", detail: `rebase onto ${r.head} failed`, about: live }])
            return { status: "failed", landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
          }
          const again = yield* gate(`verify:${attempt}`)
          if (!again.passed) {
            yield* report([{ kind: "verify-failing", title: "verify fails on top of your new commits", detail: again.output.slice(-4000), about: live }])
            return { status: "failed", landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
          }
          base = r.head!
          commit = yield* act(`rebased:${attempt}`, Schema.String, squash(base, payload.graph))
          continue
        }
        if (r.status === "refused" || attempt >= spec.landAttempts) {
          const detail = r.status === "refused" ? r.reason! : `waiting on your uncommitted edits in ${(r.paths ?? []).join(", ")}`
          yield* report([{ kind: "landing-blocked", title: "the implementation commit cannot land", detail, about: live }])
          return { status: "failed", commit, landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
        }
        yield* DurableClock.sleep({ name: `land-wait:${attempt}`, duration: spec.landRetry })
      }

      yield* act(
        "cleanup",
        Schema.Void,
        Effect.gen(function* () {
          spec.findings.clearFor(live)
          for (const [item, f] of failures) spec.findings.raise({ kind: f.kind, title: f.title, detail: f.detail, about: [item], pass: id })
          for (const item of scope.items) yield* removeWorktree(spec.repo, join(root, item), branchOf(item))
          yield* removeWorktree(spec.repo, main, branchOf("main"))
          yield* Effect.sync(() => rmSync(root, { recursive: true, force: true }))
        }),
      )
      return { status: "landed", commit, landed: live.sort(), failed: failed() } satisfies PassResult
    }),
  )
```

Append to `packages/reconcile/src/index.ts`:

```ts
export * from "./engine"
export * from "./pass"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/reconcile && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (24 tests). The resume test kills a pass process with exit code 9 while it implements UX-0002, then a second process finishes the same pass: `plan UX-0001` and `implement UX-0001` ran once, `implement UX-0002` twice.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/reconcile
git commit -m "feat(reconcile): the durable pass workflow: phases, merge, verify with fixes, one commit, landing"
```

---

### Task 7: Trigger and watcher

**Files:**
- Create: `packages/reconcile/src/trigger.ts`, `packages/reconcile/src/reconciler.ts`
- Modify: `packages/reconcile/src/index.ts`, `AGENTS.md`
- Test: `packages/reconcile/test/trigger.test.ts`

**Interfaces:**
- Consumes: `baseTree`, `workingGraphTree`, `GRAPH` (Task 2); `checkoutProblem` (Task 4); `Findings` (Task 5); `PassResult`, `Pass`, `passLayer`, `engineLayer` (Task 6).
- Produces: `makeTrigger(quietMs, run) → { notify, close, busy }`; `startReconciler({ repo, quietMs, findings, execute, onResult? }) → { notify, busy, close }` (watches `.zarg/graph`; skips when the working graph equals the last reconciled one; a checkout problem becomes a `pass-error` finding).

- [ ] **Step 1: Write the failing test**

`packages/reconcile/test/trigger.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { engineLayer, makeTrigger, Pass, passLayer, startReconciler } from "../src"
import { card, cleanup, repo, sh, state, writeNode } from "./repo"
import { stubSpec } from "./stub-spec"

afterAll(cleanup)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("trigger", () => {
  test("runs once after quiet; a notify during a run brings exactly one more run", async () => {
    let runs = 0
    let release: () => void = () => {}
    const t = makeTrigger(30, () => {
      runs++
      return new Promise<void>((r) => (release = r))
    })
    t.notify()
    t.notify()
    await sleep(10)
    t.notify()
    await sleep(60)
    expect(runs).toBe(1)
    t.notify()
    t.notify()
    await sleep(60)
    expect(runs).toBe(1)
    release()
    await sleep(80)
    expect(runs).toBe(2)
    release()
    await sleep(80)
    expect(runs).toBe(2)
    t.close()
  })
})

describe("reconciler", () => {
  const start = (r: string) => {
    const spec = stubSpec(r)
    const results: Array<string> = []
    const layer = passLayer(spec).pipe(Layer.provideMerge(engineLayer(join(mkdtempSync(join(tmpdir(), "zarg-db-")), "cluster.db"))))
    const rec = startReconciler({
      repo: r,
      quietMs: 50,
      findings: spec.findings,
      execute: (p) => Pass.execute(p).pipe(Effect.provide(layer)) as never,
      onResult: (x) => results.push(x.status),
    })
    return { rec, results, spec }
  }
  const until = async (cond: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms
    while (!cond() && Date.now() < end) await sleep(50)
  }

  test("a graph edit is reconciled into a landed commit after the quiet period", async () => {
    const r = repo()
    const { rec, results } = start(r)
    writeNode(r, state("S-0001", "home"))
    writeNode(r, card("UX-0001", "S-0001", "S-0001"))
    await until(() => results.length > 0)
    rec.close()
    expect(results).toEqual(["landed"])
    expect(sh(r, "git log -1 --format=%s")).toBe("feat: implement UX-0001")
  }, 20_000)

  test("a checkout it cannot land on (detached HEAD) raises a finding instead of running", async () => {
    const r = repo()
    sh(r, "git checkout -q --detach")
    const { rec, results, spec } = start(r)
    rec.notify()
    await until(() => results.length > 0)
    rec.close()
    expect(results).toEqual(["skipped"])
    expect(spec.findings.list().map((f) => f.kind)).toEqual(["pass-error"])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/reconcile && mise x -- bun test test/trigger.test.ts`
Expected: FAIL (`makeTrigger` is not exported).

- [ ] **Step 3: Implement**

`packages/reconcile/src/trigger.ts`:

```ts
/**
 * Runs `run` once things have been quiet for `quietMs` after the last `notify`. One run at a time: a notify
 * during a run schedules exactly one more run after it.
 */
export const makeTrigger = (quietMs: number, run: () => Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let again = false
  let closed = false
  const fire = () => {
    timer = undefined
    if (closed) return
    if (running) {
      again = true
      return
    }
    running = true
    void run()
      .catch(() => {})
      .finally(() => {
        running = false
        if (again && !closed) {
          again = false
          notify()
        }
      })
  }
  const notify = () => {
    if (closed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(fire, quietMs)
  }
  return {
    notify,
    close: () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
    },
    busy: () => running || timer !== undefined,
  }
}
```

`packages/reconcile/src/reconciler.ts`:

```ts
import { existsSync, mkdirSync, watch } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { baseTree, GRAPH, workingGraphTree } from "./checkpoint"
import type { Findings } from "./findings"
import { git } from "./git"
import { checkoutProblem } from "./land"
import type { PassResult } from "./pass"
import { makeTrigger } from "./trigger"

export interface ReconcilerOptions {
  readonly repo: string
  readonly quietMs: number
  readonly findings: Findings
  /** Run one pass (Pass.execute with the engine provided). */
  readonly execute: (payload: { graph: string; branch: string; base: string }) => Effect.Effect<PassResult, unknown>
  /** Called after each pass (for threads and logs). */
  readonly onResult?: (result: PassResult | { readonly status: "skipped"; readonly reason: string }) => void
}

/**
 * Watches `.zarg/graph` and runs a pass after `quietMs` of quiet. `notify()` also triggers (in-process graph
 * writes). A pass starts only when the working graph differs from the last reconciled one.
 */
export const startReconciler = (opts: ReconcilerOptions) => {
  const once = Effect.gen(function* () {
    const problem = yield* checkoutProblem(opts.repo)
    if (problem !== undefined) {
      opts.findings.raise({ kind: "pass-error", title: "reconcile cannot start", detail: problem, about: [], pass: "" })
      return { status: "skipped", reason: problem } as const
    }
    const graph = yield* workingGraphTree(opts.repo)
    const base = yield* git(opts.repo, ["rev-parse", "HEAD"])
    if ((yield* baseTree(opts.repo, base)) === graph) return { status: "skipped", reason: "already reconciled" } as const
    const branch = yield* git(opts.repo, ["symbolic-ref", "--short", "HEAD"])
    return yield* opts.execute({ graph, branch, base })
  })
  const trigger = makeTrigger(opts.quietMs, () =>
    Effect.runPromise(
      once.pipe(
        Effect.catchCause((cause) => {
          opts.findings.raise({ kind: "pass-error", title: "a reconcile pass failed", detail: String(cause).slice(0, 4000), about: [], pass: "" })
          return Effect.succeed({ status: "skipped", reason: "error" } as const)
        }),
        Effect.tap((r) => Effect.sync(() => opts.onResult?.(r))),
      ),
    ),
  )
  const dir = join(opts.repo, GRAPH)
  mkdirSync(dir, { recursive: true })
  const watcher = existsSync(dir) ? watch(dir, { recursive: true }, () => trigger.notify()) : undefined
  return {
    notify: trigger.notify,
    busy: trigger.busy,
    close: () => {
      watcher?.close()
      trigger.close()
    },
  }
}
```

Append to `packages/reconcile/src/index.ts`:

```ts
export * from "./reconciler"
export * from "./trigger"
```

In `AGENTS.md`, add under "## Packages", after the `packages/client` line:

```md
- `packages/reconcile` (`@zarg/reconcile`): the reconcile loop every downstream phase runs (see `intent/zarg.md`): affected cards, per-card git worktrees, merge, verify with fixes, one commit per pass landed on your branch, findings; each pass is a durable Effect workflow (`.zarg/run/cluster.db`).
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/reconcile && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (27 tests).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/reconcile AGENTS.md
git commit -m "feat(reconcile): quiet-period trigger and graph watcher"
```
