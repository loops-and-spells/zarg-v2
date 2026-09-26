# Phase 1: Graph CLI and Dogfood Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@zarg/graph`, the plugin contract with its write pipeline, the gherkin plugin, and a `zarg` CLI, plus two Claude Code skills, so Claude Code can drive zarg's own requirements and sync them into code.

**Architecture:** `@zarg/graph` stores one canonical JSON file per node under `.zarg/graph/nodes/` and offers pure snapshot, query and diff functions plus a `GraphStore` Effect service. `@zarg/plugin/server` defines the plugin contract and a `PluginHost` service that runs every change through one pipeline (decode params, run tool, structural checks, plugin lints, commit). `@zarg/plugin-gherkin/server` models the user action graph as state and card nodes. `@zarg/cli` exposes it all as JSON commands that the `zarg-drive` and `zarg-sync` skills call.

**Tech Stack:** bun 1.4.2 (via mise), Effect `4.0.0-rc.117` (`effect`, `effect/unstable/cli`, `@effect/platform-bun`), TypeScript 7, `bun test`, OpenTUI (placeholder only).

**Spec:** `docs/superpowers/specs/2026-09-25-harness-architecture-design.md` (section 7, phase 1, plus sections 2-4 for the parts phase 1 builds).

## Global Constraints

- Run bun only through mise: `mise exec -- bun ...` or `mise run ...`. A global bun 1.3.14 in `~/.bun/bin` shadows the pinned 1.4.2 in plain shells.
- Effect is the `rc` tag: `effect@rc`, `@effect/platform-bun@rc` (resolved `4.0.0-rc.117`). Services use `Context.Service<Self, Shape>()("key")`, errors use `Data.TaggedError`, formats use `Schema`.
- Every package: `package.json` named `@zarg/<name>`, `"type": "module"`, a `tsconfig.json` that extends `../../tsconfig.base.json`, and a `mise.toml` with `typecheck` (`bunx tsc`) and `test` (`bun test`) tasks.
- Cross-package imports go through package names (`@zarg/graph`), never relative paths.
- Node ids match `^[A-Za-z0-9._-]+$`. Types are namespaced `<plugin>/<type>`.
- Node files are canonical JSON: sorted keys, two-space indent, trailing newline.
- `mise run verify` is the single gate. It must pass at the end of every task.
- Commit after every task. End every commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- The code in this plan was prototyped and type-checked against `effect@4.0.0-rc.117` before writing. If an API differs, check `node_modules/effect/src/` before changing the approach.

### Deliberate differences from the spec (phase 1 only)

- A node's revision is its content hash (`hash(node)`, 12 hex chars) instead of an in-memory counter. It works across separate CLI processes.
- `GraphStore` has `load`, `snapshot` and `commit`. The `commits` stream and the file watcher wait for phase 2, when a long-running core exists to use them.
- Lints are pure functions `(ctx) => Finding[]`, not Effects.
- The plugin fields `reactor`, `project` and `layer`, and the client half, wait for phases 2 and 3. Phase 1 adds `render`, which the CLI needs.
- Gherkin states get two optional flags, `entry` and `terminal`, so the agenda can tell real dead ends from intended ones.
- No `--pretty` flag: `zarg render` is the human view. No `split-card` tool: edge cardinality already stops cards from growing past the limits.
- The import-boundary test waits for phase 3, when `@zarg/client` exists.

## Review Focus

These inputs are not covered by the spec's examples but will reach the software. Each one has a test in the task that owns the code.

1. A node id that is not a safe file name (for example `../escape`) must be refused before anything is written (Task 2, store envelope check).
2. A hand-edited or merge-damaged node file must not take down the CLI: it is skipped, shows up on the agenda, and other commands keep working (Task 2 store test, Task 6 CLI test).
3. Quotes and non-ASCII text in state text must round-trip byte-stable with a stable hash (Task 2).
4. A malformed `--expect` value must be an error, not silently ignored, because the caller believes it is protected (Task 6).
5. `diff --since` must handle a ref that has no graph yet (everything is added) and must report a bad ref as a JSON `IoError` (Task 6).

Known limit, not covered: two processes committing in the same few milliseconds can both pass the stale check (the store has no lock). The pipeline's automatic expectations make the window small. Phase 2's single-writer core closes it.

---

### Task 1: Workspace tooling and the pure graph core

**Files:**
- Move: `packages/cli/tsconfig.json` to `tsconfig.base.json` (then rewrite it)
- Create: `packages/cli/tsconfig.json`, `packages/graph/{package.json,tsconfig.json,mise.toml}`
- Create: `packages/graph/src/{node.ts,errors.ts,snapshot.ts,diff.ts,index.ts}`
- Create: `packages/graph/test/{fixtures.ts,snapshot.test.ts}`
- Modify: `package.json`, `mise.toml`, `packages/cli/package.json`, `packages/cli/mise.toml`

**Interfaces:**
- Produces (`@zarg/graph`):
  - `Node`, `Edge` (Schemas and types): `{ id, type, props: Record<string, Json>, edges: { type, to, props? }[] }`
  - `canonical(node): string`, `hash(node): string`
  - `Snapshot` namespace: `Snapshot` type `{ nodes: ReadonlyMap<string, Node>, inbound: ReadonlyMap<string, InEdge[]> }`, `make`, `empty`, `applyChanges`, `danglingEdges`, `get`, `byType`, `out`, `inbound`, `neighbors(snap, id, k)`, `nextId(snap, prefix)`
  - `Put(node)`, `Remove(id)`, `Change`
  - `diff(before, after): Diff` with `{ added: Node[], removed: Node[], changed: NodeChange[] }`, `isEmpty(diff)`
  - Errors: `InvalidNode{file, message}`, `DanglingEdge{from, type, to}`, `StaleNode{id, expected, actual}`, `IoError{path, message}`, union `GraphError`

- [ ] **Step 1: Shared TypeScript config and root dev dependencies**

```bash
git mv packages/cli/tsconfig.json tsconfig.base.json
```

Write `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true
  }
}
```

Write `packages/cli/tsconfig.json` (and later the same content in every package):

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Move the dev dependencies to the root so every package shares them:

```bash
cd packages/cli && mise exec -- bun remove @types/bun typescript && cd ../..
mise exec -- bun add -d @types/bun typescript
```

Root `package.json` is now:

```json
{
  "name": "zarg-v2",
  "private": true,
  "workspaces": ["packages/*"],
  "devDependencies": {
    "@types/bun": "^1.4.2",
    "typescript": "^7.0.2"
  }
}
```

- [ ] **Step 2: Root verify task and package tasks**

Replace root `mise.toml` with (the `zarg` task is used from Task 6 on; adding it now is harmless):

```toml
monorepo_root = true

[monorepo]
config_roots = ["packages/*"]

[tools]
bun = "1.4.2"

[tasks.verify]
description = "Typecheck and test every package. Exit code is the verdict."
depends = ["//...:typecheck", "//...:test"]

[tasks.zarg]
description = "Run this repo's zarg CLI: mise run zarg -- agenda"
run = "bun packages/cli/src/main.ts"
```

Replace `packages/cli/mise.toml` (the old `dev`/`start` tasks pointed at `src/index.ts`, which Task 6 renames; Task 6 adds the `test` task once the CLI has tests, because `bun test` fails when a package has no test files):

```toml
[tasks.typecheck]
run = "bunx tsc"
```

- [ ] **Step 3: Create the graph package**

```bash
mkdir -p packages/graph/src packages/graph/test
```

`packages/graph/package.json`:

```json
{
  "name": "@zarg/graph",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/graph/tsconfig.json`: same content as `packages/cli/tsconfig.json`. `packages/graph/mise.toml`: same content as `packages/cli/mise.toml`.

```bash
cd packages/graph && mise exec -- bun add effect@rc && mise exec -- bun add -d @effect/platform-bun@rc && cd ../..
```

- [ ] **Step 4: Write the failing tests**

`packages/graph/test/fixtures.ts`:

```ts
import type { Node } from "../src"

export const state = (id: string, text: string): Node => ({ id, type: "t/state", props: { text }, edges: [] })

export const card = (id: string, when: string, arrives: string, then: ReadonlyArray<string>): Node => ({
  id,
  type: "t/card",
  props: { when },
  edges: [{ type: "t/arrives", to: arrives }, ...then.map((to) => ({ type: "t/then", to }))],
})
```

`packages/graph/test/snapshot.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { canonical, diff, hash, Put, Remove, Snapshot } from "../src"
import { card, state } from "./fixtures"

const base = Snapshot.make([
  state("S-0001", "home"),
  state("S-0002", "picker"),
  state("S-0003", "form"),
  card("UX-0001", "clicks pricing", "S-0001", ["S-0002"]),
  card("UX-0002", "picks free", "S-0002", ["S-0003"]),
])

describe("snapshot", () => {
  test("indexes inbound edges", () => {
    expect(Snapshot.inbound(base, "S-0002").map((e) => [e.from, e.edge.type])).toEqual([
      ["UX-0001", "t/then"],
      ["UX-0002", "t/arrives"],
    ])
  })

  test("neighbors walks both directions up to k hops", () => {
    expect(Snapshot.neighbors(base, "S-0002", 1)).toEqual(["S-0002", "UX-0001", "UX-0002"])
    expect(Snapshot.neighbors(base, "S-0002", 2)).toEqual(["S-0001", "S-0002", "S-0003", "UX-0001", "UX-0002"])
  })

  test("nextId continues the highest number for a prefix", () => {
    expect(Snapshot.nextId(base, "UX")).toBe("UX-0003")
    expect(Snapshot.nextId(Snapshot.empty, "S")).toBe("S-0001")
  })

  test("danglingEdges finds edges to missing nodes", () => {
    const next = Snapshot.applyChanges(base, [Remove("S-0003")])
    expect(Snapshot.danglingEdges(next)).toEqual([{ from: "UX-0002", edge: { type: "t/then", to: "S-0003" } }])
  })
})

describe("canonical", () => {
  test("sorts keys and ends with a newline, so equal nodes hash equal", () => {
    const a = { id: "S-0001", type: "t/state", props: { b: 1, a: 2 }, edges: [] }
    const b = { edges: [], props: { a: 2, b: 1 }, type: "t/state", id: "S-0001" }
    expect(canonical(a)).toBe(canonical(b))
    expect(canonical(a).endsWith("}\n")).toBe(true)
    expect(hash(a)).toBe(hash(b))
  })
})

describe("diff", () => {
  test("reports added, removed and changed nodes keyed by id", () => {
    const next = Snapshot.applyChanges(base, [
      Put(state("S-0002", "plans listed")),
      Put(state("S-0004", "payment")),
      Remove("UX-0002"),
    ])
    const d = diff(base, next)
    expect(d.added.map((n) => n.id)).toEqual(["S-0004"])
    expect(d.removed.map((n) => n.id)).toEqual(["UX-0002"])
    expect(d.changed.map((c) => c.id)).toEqual(["S-0002"])
    expect(d.changed[0]?.props).toEqual([{ op: "replace", path: "/text", value: "plans listed" }])
  })

  test("reports edge changes on a changed node", () => {
    const next = Snapshot.applyChanges(base, [Put(card("UX-0002", "picks free", "S-0002", ["S-0001"]))])
    const edges = diff(base, next).changed[0]?.edges
    expect(edges?.added).toEqual([{ type: "t/then", to: "S-0001" }])
    expect(edges?.removed).toEqual([{ type: "t/then", to: "S-0003" }])
  })

  test("identical snapshots have an empty diff", () => {
    expect(diff(base, Snapshot.make([...base.nodes.values()]))).toEqual({ added: [], removed: [], changed: [] })
  })
})
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd packages/graph && mise exec -- bun test test/snapshot.test.ts`
Expected: FAIL, cannot resolve `../src`.

- [ ] **Step 6: Implement the pure core**

`packages/graph/src/node.ts`:

```ts
import { createHash } from "node:crypto"
import { Schema } from "effect"

export const NodeId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/))

export const Edge = Schema.Struct({
  type: Schema.String,
  to: NodeId,
  props: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})
export type Edge = typeof Edge.Type

export const Node = Schema.Struct({
  id: NodeId,
  type: Schema.String,
  props: Schema.Record(Schema.String, Schema.Json),
  edges: Schema.Array(Edge),
})
export type Node = typeof Node.Type

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

/** Sorted keys, two-space indent, trailing newline: byte-stable across writers. */
export const canonical = (node: Node): string => `${JSON.stringify(sortKeys(node), null, 2)}\n`

/** Short content hash of the canonical form. Used as the node's revision. */
export const hash = (node: Node): string =>
  createHash("sha256").update(canonical(node)).digest("hex").slice(0, 12)
```

`packages/graph/src/errors.ts`:

```ts
import { Data } from "effect"

export class InvalidNode extends Data.TaggedError("InvalidNode")<{
  readonly file: string
  readonly message: string
}> {}

export class DanglingEdge extends Data.TaggedError("DanglingEdge")<{
  readonly from: string
  readonly type: string
  readonly to: string
}> {}

export class StaleNode extends Data.TaggedError("StaleNode")<{
  readonly id: string
  readonly expected: string
  readonly actual: string | undefined
}> {}

export class IoError extends Data.TaggedError("IoError")<{
  readonly path: string
  readonly message: string
}> {}

export type GraphError = InvalidNode | DanglingEdge | StaleNode | IoError
```

`packages/graph/src/snapshot.ts`:

```ts
import type { Edge, Node } from "./node"

export interface InEdge {
  readonly from: string
  readonly edge: Edge
}

export interface Snapshot {
  readonly nodes: ReadonlyMap<string, Node>
  readonly inbound: ReadonlyMap<string, ReadonlyArray<InEdge>>
}

export type Change =
  | { readonly _tag: "Put"; readonly node: Node }
  | { readonly _tag: "Remove"; readonly id: string }

export const Put = (node: Node): Change => ({ _tag: "Put", node })
export const Remove = (id: string): Change => ({ _tag: "Remove", id })

export const make = (nodes: Iterable<Node>): Snapshot => {
  const byId = new Map<string, Node>()
  for (const n of nodes) byId.set(n.id, n)
  const inbound = new Map<string, Array<InEdge>>()
  for (const n of byId.values()) {
    for (const edge of n.edges) {
      const list = inbound.get(edge.to) ?? []
      list.push({ from: n.id, edge })
      inbound.set(edge.to, list)
    }
  }
  return { nodes: byId, inbound }
}

export const empty: Snapshot = make([])

export const applyChanges = (snap: Snapshot, changes: ReadonlyArray<Change>): Snapshot => {
  const next = new Map(snap.nodes)
  for (const c of changes) {
    if (c._tag === "Put") next.set(c.node.id, c.node)
    else next.delete(c.id)
  }
  return make(next.values())
}

/** Edges whose target is missing in the snapshot. */
export const danglingEdges = (snap: Snapshot): ReadonlyArray<{ from: string; edge: Edge }> => {
  const out: Array<{ from: string; edge: Edge }> = []
  for (const n of snap.nodes.values()) {
    for (const edge of n.edges) if (!snap.nodes.has(edge.to)) out.push({ from: n.id, edge })
  }
  return out
}

export const get = (snap: Snapshot, id: string): Node | undefined => snap.nodes.get(id)

export const byType = (snap: Snapshot, type: string): ReadonlyArray<Node> =>
  [...snap.nodes.values()].filter((n) => n.type === type).sort((a, b) => a.id.localeCompare(b.id))

export const out = (snap: Snapshot, id: string, type?: string): ReadonlyArray<Edge> =>
  (snap.nodes.get(id)?.edges ?? []).filter((e) => type === undefined || e.type === type)

export const inbound = (snap: Snapshot, id: string, type?: string): ReadonlyArray<InEdge> =>
  (snap.inbound.get(id) ?? []).filter((e) => type === undefined || e.edge.type === type)

/** Node ids within k hops, following edges in both directions. Includes `id`. */
export const neighbors = (snap: Snapshot, id: string, k: number): ReadonlyArray<string> => {
  const seen = new Set([id])
  let frontier = [id]
  for (let i = 0; i < k && frontier.length > 0; i++) {
    const next: Array<string> = []
    for (const cur of frontier) {
      const adj = [...out(snap, cur).map((e) => e.to), ...inbound(snap, cur).map((e) => e.from)]
      for (const n of adj) if (snap.nodes.has(n) && !seen.has(n)) {
        seen.add(n)
        next.push(n)
      }
    }
    frontier = next
  }
  return [...seen].sort()
}

/** Next free id for a prefix: `UX` -> `UX-0004` when `UX-0003` is the highest. */
export const nextId = (snap: Snapshot, prefix: string): string => {
  let max = 0
  const re = new RegExp(`^${prefix}-(\\d+)$`)
  for (const id of snap.nodes.keys()) {
    const m = re.exec(id)
    if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`
}
```

`packages/graph/src/diff.ts`:

```ts
import { JsonPatch } from "effect"
import { canonical, type Edge, type Node } from "./node"
import type { Snapshot } from "./snapshot"

export interface EdgeDiff {
  readonly added: ReadonlyArray<Edge>
  readonly removed: ReadonlyArray<Edge>
  readonly changed: ReadonlyArray<{ readonly before: Edge; readonly after: Edge }>
}

export interface NodeChange {
  readonly id: string
  readonly before: Node
  readonly after: Node
  readonly props: JsonPatch.JsonPatch
  readonly edges: EdgeDiff
}

export interface Diff {
  readonly added: ReadonlyArray<Node>
  readonly removed: ReadonlyArray<Node>
  readonly changed: ReadonlyArray<NodeChange>
}

const edgeKey = (e: Edge) => `${e.type}\u0000${e.to}`

const diffEdges = (before: ReadonlyArray<Edge>, after: ReadonlyArray<Edge>): EdgeDiff => {
  const b = new Map(before.map((e) => [edgeKey(e), e]))
  const a = new Map(after.map((e) => [edgeKey(e), e]))
  return {
    added: after.filter((e) => !b.has(edgeKey(e))),
    removed: before.filter((e) => !a.has(edgeKey(e))),
    changed: after.flatMap((e) => {
      const prev = b.get(edgeKey(e))
      return prev !== undefined && JSON.stringify(prev.props ?? {}) !== JSON.stringify(e.props ?? {})
        ? [{ before: prev, after: e }]
        : []
    }),
  }
}

/** Keyed by node id, like React keys. Pure. */
export const diff = (before: Snapshot, after: Snapshot): Diff => {
  const added: Array<Node> = []
  const removed: Array<Node> = []
  const changed: Array<NodeChange> = []
  for (const [id, a] of after.nodes) {
    const b = before.nodes.get(id)
    if (b === undefined) added.push(a)
    else if (canonical(a) !== canonical(b)) {
      changed.push({ id, before: b, after: a, props: JsonPatch.get(b.props, a.props), edges: diffEdges(b.edges, a.edges) })
    }
  }
  for (const [id, b] of before.nodes) if (!after.nodes.has(id)) removed.push(b)
  const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id)
  return { added: added.sort(byId), removed: removed.sort(byId), changed: changed.sort(byId) }
}

export const isEmpty = (d: Diff): boolean =>
  d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0
```

`packages/graph/src/index.ts` (Task 2 adds the store export):

```ts
export * from "./diff"
export * from "./errors"
export * from "./node"
export * as Snapshot from "./snapshot"
export { Put, Remove, type Change } from "./snapshot"
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/graph && mise exec -- bun test test/snapshot.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 8: Run the gate**

Run: `mise run verify`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A tsconfig.base.json package.json bun.lock mise.toml packages/cli packages/graph
git commit -m "feat(graph): canonical nodes, snapshot queries and keyed diff

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: GraphStore on disk

**Files:**
- Create: `packages/graph/src/store.ts`, `packages/graph/test/store.test.ts`
- Modify: `packages/graph/src/index.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `GraphStore` service: `load: Effect<Loaded, IoError>`, `snapshot: Effect<Snapshot, IoError>`, `commit(changes, expect?): Effect<Commit, GraphError>`
  - `Loaded = { snapshot, problems: InvalidNode[] }`, `Commit = { before, after, diff }`, `Expect = Record<id, hash | "absent">`
  - `layer(dir): Layer<GraphStore, never, FileSystem | Path>`, where files live in `<dir>/nodes/<id>.json`

- [ ] **Step 1: Write the failing tests**

`packages/graph/test/store.test.ts`:

```ts
import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Path } from "effect"
import { GraphStore, hash, layer, Put, Remove } from "../src"
import { card, state } from "./fixtures"

/** Runs `body` against a GraphStore rooted in a fresh temp dir. */
const withStore = <A, E>(body: (dir: string) => Effect.Effect<A, E, GraphStore | FileSystem.FileSystem | Path.Path>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
    return yield* body(dir).pipe(Effect.provide(layer(dir)))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

const failure = <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.flip(eff)

describe("GraphStore", () => {
  test("empty directory loads an empty snapshot", async () => {
    const size = await withStore(() => Effect.map(GraphStore.use((s) => s.snapshot), (s) => s.nodes.size))
    expect(size).toBe(0)
  })

  test("commit writes canonical files and snapshot reads them back", async () => {
    const result = await withStore((dir) =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        const fs = yield* FileSystem.FileSystem
        yield* store.commit([Put(state("S-0001", "home")), Put(card("UX-0001", "clicks", "S-0001", ["S-0001"]))])
        const text = yield* fs.readFileString(`${dir}/nodes/S-0001.json`)
        const snap = yield* store.snapshot
        return { text, ids: [...snap.nodes.keys()].sort() }
      }),
    )
    expect(result.text).toBe(
      '{\n  "edges": [],\n  "id": "S-0001",\n  "props": {\n    "text": "home"\n  },\n  "type": "t/state"\n}\n',
    )
    expect(result.ids).toEqual(["S-0001", "UX-0001"])
  })

  test("commit returns the diff", async () => {
    const d = await withStore(() =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        yield* store.commit([Put(state("S-0001", "home"))])
        return (yield* store.commit([Put(state("S-0001", "landing")), Put(state("S-0002", "x"))])).diff
      }),
    )
    expect(d.added.map((n) => n.id)).toEqual(["S-0002"])
    expect(d.changed.map((c) => c.id)).toEqual(["S-0001"])
  })

  test("remove deletes the file", async () => {
    const exists = await withStore((dir) =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        yield* store.commit([Put(state("S-0001", "home"))])
        yield* store.commit([Remove("S-0001")])
        return yield* (yield* FileSystem.FileSystem).exists(`${dir}/nodes/S-0001.json`)
      }),
    )
    expect(exists).toBe(false)
  })

  test("rejects an edge to a missing node and writes nothing", async () => {
    const out = await withStore((dir) =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        const err = yield* failure(store.commit([Put(card("UX-0001", "clicks", "S-0009", ["S-0009"]))]))
        const exists = yield* (yield* FileSystem.FileSystem).exists(`${dir}/nodes/UX-0001.json`)
        return { tag: err._tag, exists }
      }),
    )
    expect(out).toEqual({ tag: "DanglingEdge", exists: false })
  })

  test("rejects a stale expectation", async () => {
    const err = await withStore(() =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        const v1 = state("S-0001", "home")
        yield* store.commit([Put(v1)])
        yield* store.commit([Put(state("S-0001", "landing"))])
        return yield* failure(store.commit([Put(state("S-0001", "mine"))], { "S-0001": hash(v1) }))
      }),
    )
    expect(err._tag).toBe("StaleNode")
  })

  test("expecting a node to be absent fails once it exists", async () => {
    const err = await withStore(() =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        yield* store.commit([Put(state("S-0001", "home"))])
        return yield* failure(store.commit([Put(state("S-0001", "again"))], { "S-0001": "absent" }))
      }),
    )
    expect(err._tag).toBe("StaleNode")
  })

  test("a malformed file is skipped and reported, the rest still loads", async () => {
    const loaded = await withStore((dir) =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        yield* store.commit([Put(state("S-0002", "fine"))])
        yield* (yield* FileSystem.FileSystem).writeFileString(`${dir}/nodes/S-0001.json`, "{ not json")
        return yield* store.load
      }),
    )
    expect([...loaded.snapshot.nodes.keys()]).toEqual(["S-0002"])
    expect(loaded.problems.map((p) => p.file.endsWith("S-0001.json"))).toEqual([true])
  })

  test("a file whose id does not match its name is reported", async () => {
    const loaded = await withStore((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${dir}/nodes`, { recursive: true })
        yield* fs.writeFileString(`${dir}/nodes/S-0002.json`, JSON.stringify(state("S-0001", "home")))
        return yield* (yield* GraphStore).load
      }),
    )
    expect(loaded.snapshot.nodes.size).toBe(0)
    expect(loaded.problems[0]?.message).toContain("does not match the file name")
  })

  test("commit refuses an id that is not a safe file name", async () => {
    const err = await withStore(() =>
      Effect.gen(function* () {
        return yield* failure((yield* GraphStore).commit([Put(state("../escape", "x"))]))
      }),
    )
    expect(err._tag).toBe("InvalidNode")
  })

  test("quotes and non-ASCII text round-trip with a stable hash", async () => {
    const node = state("S-0001", 'the "Pro" plan für 10€ is shown 🎉')
    const back = await withStore(() =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        yield* store.commit([Put(node)])
        return (yield* store.snapshot).nodes.get("S-0001")
      }),
    )
    expect(back).toEqual(node)
    expect(hash(back!)).toBe(hash(node))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/graph && mise exec -- bun test test/store.test.ts`
Expected: FAIL, `GraphStore` and `layer` are not exported.

- [ ] **Step 3: Implement the store**

`packages/graph/src/store.ts`:

```ts
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { diff, type Diff } from "./diff"
import { DanglingEdge, InvalidNode, IoError, StaleNode, type GraphError } from "./errors"
import { canonical, hash, Node } from "./node"
import { applyChanges, danglingEdges, make, type Change, type Snapshot } from "./snapshot"

export interface Commit {
  readonly before: Snapshot
  readonly after: Snapshot
  readonly diff: Diff
}

/** Node id -> hash the caller last saw. A missing node is expected as `"absent"`. */
export type Expect = Readonly<Record<string, string>>

/** A load never fails on one bad file: it skips the file and reports it here. */
export interface Loaded {
  readonly snapshot: Snapshot
  readonly problems: ReadonlyArray<InvalidNode>
}

export class GraphStore extends Context.Service<
  GraphStore,
  {
    readonly load: Effect.Effect<Loaded, IoError>
    readonly snapshot: Effect.Effect<Snapshot, IoError>
    readonly commit: (changes: ReadonlyArray<Change>, expect?: Expect) => Effect.Effect<Commit, GraphError>
  }
>()("@zarg/graph/GraphStore") {}

const decodeNode = Schema.decodeUnknownEffect(Schema.fromJsonString(Node))
const checkEnvelope = Schema.decodeUnknownEffect(Node)

/**
 * Stores one canonical JSON file per node under `<dir>/nodes/<id>.json`.
 * Stateless: every call reads the directory, so separate processes see each other's writes.
 */
export const layer = (dir: string): Layer.Layer<GraphStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    GraphStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const nodesDir = path.join(dir, "nodes")
      const io = (p: string) => (e: { message: string }) => new IoError({ path: p, message: e.message })
      const fileOf = (id: string) => path.join(nodesDir, `${id}.json`)

      const load = Effect.gen(function* () {
        const exists = yield* fs.exists(nodesDir).pipe(Effect.mapError(io(nodesDir)))
        if (!exists) return { snapshot: make([]), problems: [] }
        const names = yield* fs.readDirectory(nodesDir).pipe(Effect.mapError(io(nodesDir)))
        const results = yield* Effect.forEach(
          names.filter((n) => n.endsWith(".json")).sort(),
          (name) =>
            Effect.gen(function* () {
              const file = path.join(nodesDir, name)
              const text = yield* fs.readFileString(file).pipe(Effect.mapError(io(file)))
              return yield* decodeNode(text).pipe(
                Effect.map((node) =>
                  `${node.id}.json` === name
                    ? node
                    : new InvalidNode({ file, message: `id "${node.id}" does not match the file name` }),
                ),
                Effect.catch((e) => Effect.succeed(new InvalidNode({ file, message: e.message }))),
              )
            }),
          { concurrency: 16 },
        )
        const problems = results.filter((r): r is InvalidNode => r instanceof InvalidNode)
        const nodes = results.filter((r): r is Node => !(r instanceof InvalidNode))
        return { snapshot: make(nodes), problems }
      })

      const snapshot = Effect.map(load, (l) => l.snapshot)

      const commit = (changes: ReadonlyArray<Change>, expect: Expect = {}) =>
        Effect.gen(function* () {
          for (const c of changes) {
            if (c._tag === "Put") {
              yield* checkEnvelope(c.node).pipe(
                Effect.mapError((e) => new InvalidNode({ file: String(c.node.id), message: e.message })),
              )
            }
          }
          const before = yield* snapshot
          for (const [id, expected] of Object.entries(expect)) {
            const cur = before.nodes.get(id)
            const actual = cur === undefined ? undefined : hash(cur)
            if ((actual ?? "absent") !== expected) return yield* new StaleNode({ id, expected, actual })
          }
          const after = applyChanges(before, changes)
          const dangling = danglingEdges(after)[0]
          if (dangling !== undefined) {
            return yield* new DanglingEdge({ from: dangling.from, type: dangling.edge.type, to: dangling.edge.to })
          }
          const d = diff(before, after)
          yield* fs.makeDirectory(nodesDir, { recursive: true }).pipe(Effect.mapError(io(nodesDir)))
          for (const node of [...d.added, ...d.changed.map((c) => c.after)]) {
            const file = fileOf(node.id)
            const tmp = `${file}.tmp`
            yield* fs.writeFileString(tmp, canonical(node)).pipe(Effect.mapError(io(tmp)))
            yield* fs.rename(tmp, file).pipe(Effect.mapError(io(file)))
          }
          for (const node of d.removed) {
            yield* fs.remove(fileOf(node.id)).pipe(Effect.mapError(io(fileOf(node.id))))
          }
          return { before, after, diff: d }
        })

      return { load, snapshot, commit }
    }),
  )
```

`packages/graph/src/index.ts`:

```ts
export * from "./diff"
export * from "./errors"
export * from "./node"
export * as Snapshot from "./snapshot"
export { Put, Remove, type Change } from "./snapshot"
export * from "./store"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/graph && mise exec -- bun test`
Expected: PASS, 19 tests.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/graph
git commit -m "feat(graph): GraphStore with canonical files, stale and dangling checks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Plugin contract and structural checks

**Files:**
- Create: `packages/plugin/{package.json,tsconfig.json,mise.toml}`
- Create: `packages/plugin/src/server/{plugin.ts,validate.ts,index.ts}`
- Create: `packages/plugin/test/{fixture-plugin.ts,validate.test.ts}`

**Interfaces:**
- Consumes: `@zarg/graph` (`Snapshot`, `Diff`, `Change`, `Node`, `Put`).
- Produces (`@zarg/plugin/server`):
  - `ServerPlugin { name, requires?, nodes?, edges?, lints?, tools?, agenda?, render? }` and `server(plugin)`
  - `EdgeSpec { from, to, min?, max? }` (local type names)
  - `Finding { severity: "error" | "warn", code, message, about: string[] }`, `LintContext { before, after, diff }`, `Lint`
  - `Tool<A> { name, description, params: Schema.ConstraintDecoder<A>, run(params, snapshot): Effect<ToolResult, ToolError> }`, `tool(t)`, `ToolResult { changes, message }`, `ToolError{message}`
  - `AgendaItem { id, title, detail, about: string[], priority }`
  - `registry(plugins): Registry` (throws `PluginConfigError`), `check(registry, ctx): Finding[]`

- [ ] **Step 1: Create the package**

```bash
mkdir -p packages/plugin/src/server packages/plugin/test
```

`packages/plugin/package.json`:

```json
{
  "name": "@zarg/plugin",
  "private": true,
  "type": "module",
  "exports": { "./server": "./src/server/index.ts" },
  "dependencies": { "@zarg/graph": "workspace:*" }
}
```

Copy `tsconfig.json` and `mise.toml` from `packages/graph`. Then:

```bash
cd packages/plugin && mise exec -- bun add effect@rc && mise exec -- bun add -d @effect/platform-bun@rc && cd ../..
```

- [ ] **Step 2: Write the failing tests**

`packages/plugin/test/fixture-plugin.ts` (a small plugin used by this package's tests):

```ts
import { Effect, Schema } from "effect"
import { Put, Snapshot } from "@zarg/graph"
import { server, tool, ToolError } from "../src/server"

/** A tiny plugin: notes that must link to exactly one topic. */
export const notes = server({
  name: "notes",
  nodes: {
    topic: Schema.Struct({ name: Schema.String }),
    note: Schema.Struct({ text: Schema.String }),
  },
  edges: { about: { from: "note", to: "topic", min: 1, max: 1 } },
  lints: [
    ({ diff }) =>
      [...diff.added, ...diff.changed.map((c) => c.after)]
        .filter((n) => n.type === "notes/note" && String(n.props.text).includes("TODO"))
        .map((n) => ({ severity: "warn" as const, code: "todo", message: `${n.id} has a TODO`, about: [n.id] })),
    ({ diff }) =>
      diff.added
        .filter((n) => n.type === "notes/topic" && n.props.name === "")
        .map((n) => ({ severity: "error" as const, code: "empty-name", message: `${n.id}: name is empty`, about: [n.id] })),
  ],
  tools: [
    tool({
      name: "add-topic",
      description: "Add a topic",
      params: Schema.Struct({ name: Schema.String }),
      run: ({ name }, snap) => {
        const id = Snapshot.nextId(snap, "T")
        return Effect.succeed({
          changes: [Put({ id, type: "notes/topic", props: { name }, edges: [] })],
          message: `created ${id}`,
        })
      },
    }),
    tool({
      name: "add-note",
      description: "Add a note about a topic",
      params: Schema.Struct({ text: Schema.String, topic: Schema.String }),
      run: ({ text, topic }, snap) => {
        if (!snap.nodes.has(topic)) return Effect.fail(new ToolError({ message: `no topic ${topic}` }))
        const id = Snapshot.nextId(snap, "N")
        return Effect.succeed({
          changes: [Put({ id, type: "notes/note", props: { text }, edges: [{ type: "notes/about", to: topic }] })],
          message: `created ${id}`,
        })
      },
    }),
  ],
  agenda: (snap) =>
    Snapshot.byType(snap, "notes/topic")
      .filter((t) => Snapshot.inbound(snap, t.id, "notes/about").length === 0)
      .map((t) => ({ id: `empty:${t.id}`, title: `${t.id} has no notes`, detail: "", about: [t.id], priority: 2 })),
  render: (snap, focus) =>
    Snapshot.byType(snap, "notes/topic")
      .filter((t) => focus === undefined || focus.has(t.id))
      .map((t) => `# ${String(t.props.name)}`)
      .join("\n"),
})
```

`packages/plugin/test/validate.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { diff, type Node, Snapshot } from "@zarg/graph"
import { check, PluginConfigError, registry, server } from "../src/server"
import { notes } from "./fixture-plugin"

const reg = registry([notes])
const topic: Node = { id: "T-0001", type: "notes/topic", props: { name: "x" }, edges: [] }
const findings = (nodes: ReadonlyArray<Node>) => {
  const after = Snapshot.make(nodes)
  return check(reg, { before: Snapshot.empty, after, diff: diff(Snapshot.empty, after) }).map((f) => f.code)
}

describe("registry", () => {
  test("rejects a duplicate plugin name", () => {
    expect(() => registry([notes, notes])).toThrow(PluginConfigError)
  })
  test("rejects a missing required plugin", () => {
    expect(() => registry([server({ name: "x", requires: ["y"] })])).toThrow('requires "y"')
  })
  test("rejects an edge between unknown node types", () => {
    const bad = server({ name: "x", nodes: { a: Schema.Struct({}) }, edges: { e: { from: "a", to: "b" } } })
    expect(() => registry([bad])).toThrow('unknown node type "x/b"')
  })
})

describe("check", () => {
  test("a valid graph has no findings", () => {
    expect(findings([topic, { id: "N-0001", type: "notes/note", props: { text: "hi" }, edges: [{ type: "notes/about", to: "T-0001" }] }])).toEqual([])
  })
  test("unknown node type", () => {
    expect(findings([{ id: "X-1", type: "nope/x", props: {}, edges: [] }])).toEqual(["unknown-type"])
  })
  test("props that fail the schema", () => {
    expect(findings([{ ...topic, props: { name: 3 } }])).toEqual(["invalid-props"])
  })
  test("too few and too many edges", () => {
    expect(findings([topic, { id: "N-0001", type: "notes/note", props: { text: "hi" }, edges: [] }])).toEqual(["too-few-edges"])
    const two = [{ type: "notes/about", to: "T-0001" }, { type: "notes/about", to: "T-0002" }]
    expect(findings([topic, { ...topic, id: "T-0002" }, { id: "N-0001", type: "notes/note", props: { text: "hi" }, edges: two }])).toEqual(["too-many-edges"])
  })
  test("edge pointing at the wrong node type", () => {
    const n1: Node = { id: "N-0001", type: "notes/note", props: { text: "a" }, edges: [{ type: "notes/about", to: "T-0001" }] }
    const n2: Node = { id: "N-0002", type: "notes/note", props: { text: "b" }, edges: [{ type: "notes/about", to: "N-0001" }] }
    expect(findings([topic, n1, n2])).toEqual(["edge-target"])
  })
  test("plugin lints run after structural checks", () => {
    expect(findings([{ ...topic, props: { name: "" } }])).toEqual(["empty-name"])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/plugin && mise exec -- bun test test/validate.test.ts`
Expected: FAIL, cannot resolve `../src/server`.

- [ ] **Step 4: Implement the contract and checks**

`packages/plugin/src/server/plugin.ts`:

```ts
import { Data, type Effect, type Schema } from "effect"
import type { Change, Diff, Snapshot } from "@zarg/graph"

/** Edge cardinality between two of the plugin's node types (local names, e.g. "card"). */
export interface EdgeSpec {
  readonly from: string
  readonly to: string
  readonly min?: number
  readonly max?: number
}

export interface Finding {
  readonly severity: "error" | "warn"
  readonly code: string
  readonly message: string
  readonly about: ReadonlyArray<string>
}

export interface LintContext {
  readonly before: Snapshot.Snapshot
  readonly after: Snapshot.Snapshot
  readonly diff: Diff
}

/** Pure check over a proposed change. Look at `diff` to only judge what changed. */
export type Lint = (ctx: LintContext) => ReadonlyArray<Finding>

export class ToolError extends Data.TaggedError("ToolError")<{ readonly message: string }> {}

export interface ToolResult {
  readonly changes: ReadonlyArray<Change>
  /** One line for the agent: what happened, with the ids it created. */
  readonly message: string
}

export interface Tool<A = any> {
  readonly name: string
  readonly description: string
  readonly params: Schema.ConstraintDecoder<A>
  readonly run: (params: A, snapshot: Snapshot.Snapshot) => Effect.Effect<ToolResult, ToolError>
}

/** Helper that infers `run`'s params from the schema. */
export const tool = <A>(t: Tool<A>): Tool<A> => t

export interface AgendaItem {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly about: ReadonlyArray<string>
  /** 1 is most urgent. */
  readonly priority: number
}

export interface ServerPlugin {
  readonly name: string
  readonly requires?: ReadonlyArray<string>
  readonly nodes?: Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>
  readonly edges?: Readonly<Record<string, EdgeSpec>>
  readonly lints?: ReadonlyArray<Lint>
  readonly tools?: ReadonlyArray<Tool>
  readonly agenda?: (snapshot: Snapshot.Snapshot) => ReadonlyArray<AgendaItem>
  /** Human-readable view of the plugin's part of the graph, limited to `focus` ids when given. */
  readonly render?: (snapshot: Snapshot.Snapshot, focus?: ReadonlySet<string>) => string
}

export const server = (plugin: ServerPlugin): ServerPlugin => plugin
```

`packages/plugin/src/server/validate.ts`:

```ts
import { Schema } from "effect"
import type { Node } from "@zarg/graph"
import type { EdgeSpec, Finding, LintContext, ServerPlugin } from "./plugin"

export interface Registry {
  readonly plugins: ReadonlyArray<ServerPlugin>
  readonly nodes: ReadonlyMap<string, Schema.ConstraintDecoder<unknown>>
  /** Full edge type -> spec with full node type names. */
  readonly edges: ReadonlyMap<string, EdgeSpec>
}

export class PluginConfigError extends Error {}

export const registry = (plugins: ReadonlyArray<ServerPlugin>): Registry => {
  const names = new Set<string>()
  const nodes = new Map<string, Schema.ConstraintDecoder<unknown>>()
  const edges = new Map<string, EdgeSpec>()
  for (const p of plugins) {
    if (names.has(p.name)) throw new PluginConfigError(`plugin "${p.name}" is registered twice`)
    names.add(p.name)
  }
  for (const p of plugins) {
    for (const r of p.requires ?? []) {
      if (!names.has(r)) throw new PluginConfigError(`plugin "${p.name}" requires "${r}", which is not registered`)
    }
    for (const [local, schema] of Object.entries(p.nodes ?? {})) nodes.set(`${p.name}/${local}`, schema)
  }
  const full = (owner: string, type: string) => (type.includes("/") ? type : `${owner}/${type}`)
  for (const p of plugins) {
    for (const [local, spec] of Object.entries(p.edges ?? {})) {
      const resolved = { ...spec, from: full(p.name, spec.from), to: full(p.name, spec.to) }
      for (const t of [resolved.from, resolved.to]) {
        if (!nodes.has(t)) throw new PluginConfigError(`edge "${p.name}/${local}" uses unknown node type "${t}"`)
      }
      edges.set(`${p.name}/${local}`, resolved)
    }
  }
  return { plugins, nodes, edges }
}

const error = (code: string, message: string, about: ReadonlyArray<string>): Finding => ({
  severity: "error",
  code,
  message,
  about,
})

/** Schema, edge-type and cardinality checks for one node, against the snapshot it lives in. */
const checkNode = (reg: Registry, ctx: LintContext, node: Node): ReadonlyArray<Finding> => {
  const schema = reg.nodes.get(node.type)
  if (schema === undefined) return [error("unknown-type", `${node.id}: unknown node type "${node.type}"`, [node.id])]
  const out: Array<Finding> = []
  const decoded = Schema.decodeUnknownExit(schema)(node.props)
  if (decoded._tag === "Failure") {
    out.push(error("invalid-props", `${node.id}: props do not match ${node.type}: ${String(decoded.cause)}`, [node.id]))
  }
  for (const edge of node.edges) {
    const spec = reg.edges.get(edge.type)
    if (spec === undefined) {
      out.push(error("unknown-edge", `${node.id}: unknown edge type "${edge.type}"`, [node.id]))
      continue
    }
    if (spec.from !== node.type) {
      out.push(error("edge-source", `${node.id}: "${edge.type}" edges must start at a ${spec.from}`, [node.id]))
    }
    const target = ctx.after.nodes.get(edge.to)
    if (target !== undefined && target.type !== spec.to) {
      out.push(error("edge-target", `${node.id}: "${edge.type}" must point to a ${spec.to}, ${edge.to} is a ${target.type}`, [node.id, edge.to]))
    }
  }
  for (const [type, spec] of reg.edges) {
    if (spec.from !== node.type) continue
    const n = node.edges.filter((e) => e.type === type).length
    if (spec.min !== undefined && n < spec.min) {
      out.push(error("too-few-edges", `${node.id}: needs at least ${spec.min} "${type}" edge(s), has ${n}`, [node.id]))
    }
    if (spec.max !== undefined && n > spec.max) {
      out.push(error("too-many-edges", `${node.id}: allows at most ${spec.max} "${type}" edge(s), has ${n}`, [node.id]))
    }
  }
  return out
}

/** Every check for a proposed change: structure of touched nodes, then every plugin's lints. */
export const check = (reg: Registry, ctx: LintContext): ReadonlyArray<Finding> => [
  ...[...ctx.diff.added, ...ctx.diff.changed.map((c) => c.after)].flatMap((n) => checkNode(reg, ctx, n)),
  ...reg.plugins.flatMap((p) => (p.lints ?? []).flatMap((lint) => lint(ctx))),
]
```

`packages/plugin/src/server/index.ts` (Task 4 adds the host export):

```ts
export * from "./plugin"
export { check, PluginConfigError, registry, type Registry } from "./validate"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/plugin && mise exec -- bun test test/validate.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/plugin bun.lock
git commit -m "feat(plugin): server plugin contract with schema, edge and lint checks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: PluginHost and the write pipeline

**Files:**
- Create: `packages/plugin/src/server/host.ts`, `packages/plugin/test/host.test.ts`
- Modify: `packages/plugin/src/server/index.ts`

**Interfaces:**
- Consumes: Task 2 `GraphStore`, `Expect`, `Loaded`, `hash`; Task 3 contract and `check`.
- Produces:
  - `PluginHost` service: `tools: ToolInfo[]` (`{ name: "<plugin>/<tool>", description, params: JSON Schema }`), `call(name, params, expect?): Effect<CallResult, ToolError | LintFailed | GraphError>`, `lint: Effect<Finding[], IoError>`, `agenda(focus?): Effect<AgendaItem[], IoError>`, `render(focus?): Effect<string, IoError>`
  - `CallResult { message, added, changed, removed, warnings }`, `LintFailed{findings}`
  - `layer(plugins): Layer<PluginHost, PluginConfigError, GraphStore>`
- Behavior: `call` records the hash (or `"absent"`) of every node its changes touch and passes those to `commit` together with the caller's `expect` (the caller wins). Unreadable node files become priority-1 agenda items with id `invalid-file:<path>`.

- [ ] **Step 1: Write the failing tests**

`packages/plugin/test/host.test.ts`:

```ts
import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { GraphStore, hash, layer as graphLayer } from "@zarg/graph"
import { layer as hostLayer, PluginHost } from "../src/server"
import { notes } from "./fixture-plugin"

const run = <A, E>(body: Effect.Effect<A, E, PluginHost | GraphStore | FileSystem.FileSystem>) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    const graph = graphLayer(dir)
    return yield* body.pipe(Effect.provide(Layer.provideMerge(hostLayer([notes]), graph)))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

describe("PluginHost.call", () => {
  test("runs a tool and commits its changes", async () => {
    const out = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        const r = yield* host.call("notes/add-topic", { name: "pricing" })
        const snap = yield* (yield* GraphStore).snapshot
        return { r, ids: [...snap.nodes.keys()] }
      }),
    )
    expect(out.r).toEqual({ message: "created T-0001", added: ["T-0001"], changed: [], removed: [], warnings: [] })
    expect(out.ids).toEqual(["T-0001"])
  })

  test("unknown tool and invalid params are ToolErrors", async () => {
    const errs = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        const a = yield* Effect.flip(host.call("notes/nope", {}))
        const b = yield* Effect.flip(host.call("notes/add-topic", { name: 1 }))
        return [a, b]
      }),
    )
    expect(errs.map((e) => e._tag)).toEqual(["ToolError", "ToolError"])
    expect(errs[0]?._tag === "ToolError" && errs[0].message).toContain("zarg tool list")
  })

  test("an error finding blocks the commit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        const err = yield* Effect.flip(host.call("notes/add-topic", { name: "" }))
        const size = (yield* (yield* GraphStore).snapshot).nodes.size
        return { err, size }
      }),
    )
    expect(out.err._tag).toBe("LintFailed")
    expect(out.size).toBe(0)
  })

  test("warnings are returned and do not block", async () => {
    const r = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        yield* host.call("notes/add-topic", { name: "a" })
        return yield* host.call("notes/add-note", { text: "TODO later", topic: "T-0001" })
      }),
    )
    expect(r.added).toEqual(["N-0001"])
    expect(r.warnings.map((w) => w.code)).toEqual(["todo"])
  })

  test("a caller expectation that no longer holds fails with StaleNode", async () => {
    const err = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        yield* host.call("notes/add-topic", { name: "a" })
        const t = (yield* (yield* GraphStore).snapshot).nodes.get("T-0001")!
        const seen = hash(t)
        yield* (yield* GraphStore).commit([{ _tag: "Put", node: { ...t, props: { name: "b" } } }])
        return yield* Effect.flip(host.call("notes/add-note", { text: "x", topic: "T-0001" }, { "T-0001": seen }))
      }),
    )
    expect(err._tag).toBe("StaleNode")
  })
})

describe("PluginHost read side", () => {
  test("agenda lists plugin items and bad files, filtered by focus", async () => {
    const out = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        yield* host.call("notes/add-topic", { name: "a" })
        yield* host.call("notes/add-topic", { name: "b" })
        const all = yield* host.agenda()
        const focused = yield* host.agenda(new Set(["T-0002"]))
        return { all: all.map((i) => i.id), focused: focused.map((i) => i.id) }
      }),
    )
    expect(out.all).toEqual(["empty:T-0001", "empty:T-0002"])
    expect(out.focused).toEqual(["empty:T-0002"])
  })

  test("render joins plugin views", async () => {
    const text = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost
        yield* host.call("notes/add-topic", { name: "pricing" })
        return yield* host.render()
      }),
    )
    expect(text).toBe("# pricing")
  })

  test("lint checks the whole graph", async () => {
    const codes = await run(
      Effect.gen(function* () {
        yield* (yield* GraphStore).commit([
          { _tag: "Put", node: { id: "N-0001", type: "notes/note", props: { text: "x" }, edges: [] } },
        ])
        return (yield* (yield* PluginHost).lint).map((f) => f.code)
      }),
    )
    expect(codes).toEqual(["too-few-edges"])
  })

  test("tools lists names with JSON schema params", async () => {
    const tools = await run(PluginHost.use((h) => Effect.succeed(h.tools)))
    expect(tools.map((t) => t.name)).toEqual(["notes/add-topic", "notes/add-note"])
    expect(JSON.stringify(tools[0]?.params)).toContain('"name"')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/plugin && mise exec -- bun test test/host.test.ts`
Expected: FAIL, `layer` and `PluginHost` are not exported.

- [ ] **Step 3: Implement the host**

`packages/plugin/src/server/host.ts`:

```ts
import { Context, Data, Effect, Layer, Schema } from "effect"
import {
  diff,
  type Expect,
  GraphStore,
  type GraphError,
  hash,
  type IoError,
  type Loaded,
  Snapshot,
} from "@zarg/graph"
import { type AgendaItem, type Finding, type ServerPlugin, type Tool, ToolError } from "./plugin"
import { check, PluginConfigError, registry } from "./validate"

export class LintFailed extends Data.TaggedError("LintFailed")<{ readonly findings: ReadonlyArray<Finding> }> {}

export interface ToolInfo {
  readonly name: string
  readonly description: string
  readonly params: unknown
}

export interface CallResult {
  readonly message: string
  readonly added: ReadonlyArray<string>
  readonly changed: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<Finding>
}

export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly tools: ReadonlyArray<ToolInfo>
    /** Run a tool through the write pipeline: decode params, run, check, commit. */
    readonly call: (
      name: string,
      params: unknown,
      expect?: Expect,
    ) => Effect.Effect<CallResult, ToolError | LintFailed | GraphError>
    /** Check the whole graph as if every node were new. */
    readonly lint: Effect.Effect<ReadonlyArray<Finding>, IoError>
    readonly agenda: (focus?: ReadonlySet<string>) => Effect.Effect<ReadonlyArray<AgendaItem>, IoError>
    readonly render: (focus?: ReadonlySet<string>) => Effect.Effect<string, IoError>
  }
>()("@zarg/plugin/PluginHost") {}

const problemItems = (loaded: Loaded): ReadonlyArray<AgendaItem> =>
  loaded.problems.map((p) => ({
    id: `invalid-file:${p.file}`,
    title: `Fix ${p.file}`,
    detail: p.message,
    about: [],
    priority: 1,
  }))

const inFocus = (focus: ReadonlySet<string> | undefined, about: ReadonlyArray<string>) =>
  focus === undefined || about.length === 0 || about.some((id) => focus.has(id))

export const layer = (
  plugins: ReadonlyArray<ServerPlugin>,
): Layer.Layer<PluginHost, PluginConfigError, GraphStore> =>
  Layer.effect(
    PluginHost,
    Effect.gen(function* () {
      const store = yield* GraphStore
      const reg = yield* Effect.try({
        try: () => registry(plugins),
        catch: (e) => (e instanceof PluginConfigError ? e : new PluginConfigError(String(e))),
      })
      const tools = new Map<string, Tool>()
      for (const p of plugins) for (const t of p.tools ?? []) tools.set(`${p.name}/${t.name}`, t)

      const call = (name: string, raw: unknown, expect: Expect = {}) =>
        Effect.gen(function* () {
          const t = tools.get(name)
          if (t === undefined) {
            return yield* new ToolError({ message: `unknown tool "${name}"; run \`zarg tool list\`` })
          }
          const params = yield* Schema.decodeUnknownEffect(t.params)(raw).pipe(
            Effect.mapError((e) => new ToolError({ message: `${name}: invalid params: ${e.message}` })),
          )
          const before = yield* store.snapshot
          const result = yield* t.run(params, before)
          const after = Snapshot.applyChanges(before, result.changes)
          const d = diff(before, after)
          const findings = check(reg, { before, after, diff: d })
          const errors = findings.filter((f) => f.severity === "error")
          if (errors.length > 0) return yield* new LintFailed({ findings: errors })
          // Guard against writes that land between our read and our commit.
          const touched: Record<string, string> = {}
          for (const c of result.changes) {
            const id = c._tag === "Put" ? c.node.id : c.id
            const cur = before.nodes.get(id)
            touched[id] = cur === undefined ? "absent" : hash(cur)
          }
          yield* store.commit(result.changes, { ...touched, ...expect })
          return {
            message: result.message,
            added: d.added.map((n) => n.id),
            changed: d.changed.map((c) => c.id),
            removed: d.removed.map((n) => n.id),
            warnings: findings,
          }
        })

      const lint = Effect.map(store.snapshot, (after) =>
        check(reg, { before: Snapshot.empty, after, diff: diff(Snapshot.empty, after) }),
      )

      const agenda = (focus?: ReadonlySet<string>) =>
        Effect.map(store.load, (loaded) =>
          [...problemItems(loaded), ...plugins.flatMap((p) => p.agenda?.(loaded.snapshot) ?? [])]
            .filter((item) => inFocus(focus, item.about))
            .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
        )

      const render = (focus?: ReadonlySet<string>) =>
        Effect.map(store.snapshot, (snap) =>
          plugins
            .flatMap((p) => (p.render === undefined ? [] : [p.render(snap, focus)]))
            .filter((s) => s.length > 0)
            .join("\n\n"),
        )

      return {
        tools: [...tools].map(([name, t]) => ({
          name,
          description: t.description,
          params: Schema.toJsonSchemaDocument(t.params),
        })),
        call,
        lint,
        agenda,
        render,
      }
    }),
  )
```

`packages/plugin/src/server/index.ts`:

```ts
export * from "./host"
export * from "./plugin"
export { check, PluginConfigError, registry, type Registry } from "./validate"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/plugin && mise exec -- bun test`
Expected: PASS, 18 tests.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/plugin
git commit -m "feat(plugin): PluginHost write pipeline, agenda, render and lint

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Gherkin plugin

**Files:**
- Create: `packages/plugin-gherkin/{package.json,tsconfig.json,mise.toml}`
- Create: `packages/plugin-gherkin/src/server/{model.ts,lints.ts,tools.ts,agenda.ts,render.ts,index.ts}`
- Create: `packages/plugin-gherkin/test/{harness.ts,gherkin.test.ts}`

**Interfaces:**
- Consumes: `@zarg/graph`, `@zarg/plugin/server`.
- Produces (`@zarg/plugin-gherkin/server`): `gherkin: ServerPlugin` with
  - node types `gherkin/state` (`{ text, entry?, terminal? }`) and `gherkin/card` (`{ title, when }`)
  - edges `gherkin/arrives` (card to state, exactly 1), `gherkin/given` (0-3), `gherkin/then` (1-5)
  - tools `add-state`, `edit-state`, `add-card`, `edit-card`, `link`, `unlink`, `remove`. A state reference is `{"id": "S-0002"}` or `{"text": "..."}`, and text that already exists reuses that state.
  - lints `clause-too-long` (error, over 15 words), `conditional` (error, "if"), `and-chaining` (warn), `duplicate-state` (error), `near-duplicate-state` (warn, word overlap of 0.8 or more)
  - agenda items `gherkin:empty`, `gherkin:dead-end:<S>`, `gherkin:unreached:<S>`, `gherkin:near-duplicate:<A>:<B>`
  - `render`: Gherkin text per card with `# <state id>` comments, then "States without cards:"
  - Id prefixes: states `S-NNNN`, cards `UX-NNNN`.

- [ ] **Step 1: Create the package**

```bash
mkdir -p packages/plugin-gherkin/src/server packages/plugin-gherkin/test
```

`packages/plugin-gherkin/package.json`:

```json
{
  "name": "@zarg/plugin-gherkin",
  "private": true,
  "type": "module",
  "exports": { "./server": "./src/server/index.ts" },
  "dependencies": {
    "@zarg/graph": "workspace:*",
    "@zarg/plugin": "workspace:*"
  }
}
```

Copy `tsconfig.json` and `mise.toml` from `packages/graph`. Then:

```bash
cd packages/plugin-gherkin && mise exec -- bun add effect@rc && mise exec -- bun add -d @effect/platform-bun@rc && cd ../..
```

- [ ] **Step 2: Write the failing tests**

`packages/plugin-gherkin/test/harness.ts` (builds the spec's pricing example through the tools):

```ts
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer } from "effect"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { layer as hostLayer, PluginHost } from "@zarg/plugin/server"
import { gherkin } from "../src/server"

/** Runs `body` with a PluginHost (gherkin only) over a fresh temp graph. */
export const run = <A, E>(body: Effect.Effect<A, E, PluginHost | GraphStore>) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    return yield* body.pipe(Effect.provide(Layer.provideMerge(hostLayer([gherkin]), graphLayer(dir))))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

export const call = (name: string, params: unknown) =>
  PluginHost.use((h) => h.call(`gherkin/${name}`, params))

/** The pricing flow from the design spec. */
export const pricing = Effect.gen(function* () {
  yield* call("add-state", { text: "the visitor is on the home page", entry: true })
  yield* call("add-card", { title: "Visitor opens pricing", when: 'the visitor clicks "Pricing"', arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown" }] })
  yield* call("add-card", { title: "Visitor picks Free", when: "the visitor picks Free", arrives: { text: "the plan picker is shown" }, then: [{ text: "the account form is shown" }] })
  yield* call("add-card", { title: "Visitor picks Pro", when: "the visitor picks Pro", arrives: { id: "S-0002" }, then: [{ text: "the payment form is shown" }] })
  yield* call("add-card", { title: "Payment succeeds", when: "the visitor pays with a valid card", arrives: { id: "S-0004" }, then: [{ id: "S-0003" }, { text: "a receipt is emailed" }] })
  yield* call("add-card", { title: "Payment is declined", when: "the card is declined", arrives: { id: "S-0004" }, then: [{ id: "S-0004" }, { text: "a decline message is shown" }] })
})
```

`packages/plugin-gherkin/test/gherkin.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { call, pricing, run } from "./harness"

describe("pricing example", () => {
  test("renders as Gherkin with shared states", async () => {
    const text = await run(Effect.andThen(pricing, PluginHost.use((h) => h.render(new Set(["UX-0003"])))))
    expect(text).toBe(
      [
        "UX-0003 Visitor picks Pro",
        "  Given the plan picker is shown  # S-0002",
        "  When  the visitor picks Pro",
        "  Then  the payment form is shown  # S-0004",
      ].join("\n"),
    )
  })

  test("state text given by value is reused, not duplicated", async () => {
    const text = await run(Effect.andThen(pricing, PluginHost.use((h) => h.render())))
    expect(text.match(/# S-0002/g)?.length).toBe(3)
    expect(text).not.toContain("S-0007")
  })

  test("rewording a state changes every card that uses it", async () => {
    const text = await run(
      Effect.gen(function* () {
        yield* pricing
        const r = yield* call("edit-state", { id: "S-0002", text: "the pricing plans are listed" })
        expect(r.changed).toEqual(["S-0002"])
        return yield* PluginHost.use((h) => h.render())
      }),
    )
    expect(text.match(/the pricing plans are listed/g)?.length).toBe(3)
    expect(text).not.toContain("plan picker")
  })

  test("agenda: receipt and decline message are dead ends until marked terminal", async () => {
    const ids = await run(
      Effect.gen(function* () {
        yield* pricing
        const before = (yield* PluginHost.use((h) => h.agenda())).map((i) => i.id)
        yield* call("edit-state", { id: "S-0005", terminal: true })
        const after = (yield* PluginHost.use((h) => h.agenda())).map((i) => i.id)
        return { before, after }
      }),
    )
    expect(ids.before).toEqual([
      "gherkin:dead-end:S-0003",
      "gherkin:dead-end:S-0005",
      "gherkin:dead-end:S-0006",
    ])
    expect(ids.after).toEqual(["gherkin:dead-end:S-0003", "gherkin:dead-end:S-0006"])
  })
})

describe("gherkin rules", () => {
  test("an empty graph asks for the first requirement", async () => {
    const items = await run(PluginHost.use((h) => h.agenda()))
    expect(items.map((i) => i.id)).toEqual(["gherkin:empty"])
  })

  test("a state nothing leads to is unreached unless it is an entry", async () => {
    const ids = await run(
      Effect.andThen(call("add-state", { text: "a lonely screen", terminal: true }), PluginHost.use((h) => h.agenda())),
    )
    expect(ids.map((i) => i.id)).toEqual(["gherkin:unreached:S-0001"])
  })

  test("a card needs at least one Then", async () => {
    const err = await run(
      Effect.flip(call("add-card", { title: "t", when: "the user waits", arrives: { text: "a page is shown" }, then: [] })),
    )
    expect(err._tag).toBe("LintFailed")
    expect(err._tag === "LintFailed" && err.findings[0]?.code).toBe("too-few-edges")
  })

  test("more than five Thens is rejected", async () => {
    const then = [1, 2, 3, 4, 5, 6].map((i) => ({ text: `outcome number ${i} is shown` }))
    const err = await run(Effect.flip(call("add-card", { title: "t", when: "the user acts", arrives: { text: "start" }, then })))
    expect(err._tag === "LintFailed" && err.findings.map((f) => f.code)).toContain("too-many-edges")
  })

  test("a clause with 'if' is rejected", async () => {
    const err = await run(Effect.flip(call("add-state", { text: "the form is shown if the user is signed in" })))
    expect(err._tag === "LintFailed" && err.findings[0]?.code).toBe("conditional")
  })

  test("a clause over 15 words is rejected", async () => {
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen"
    const err = await run(Effect.flip(call("add-state", { text: long })))
    expect(err._tag === "LintFailed" && err.findings[0]?.code).toBe("clause-too-long")
  })

  test("'and' is a warning only", async () => {
    const r = await run(call("add-state", { text: "the cart and the total are shown" }))
    expect(r.warnings.map((w) => w.code)).toEqual(["and-chaining"])
  })

  test("adding a state with existing text points at the existing one", async () => {
    const err = await run(
      Effect.andThen(call("add-state", { text: "the home page" }), Effect.flip(call("add-state", { text: "The home page." }))),
    )
    expect(err._tag === "ToolError" && err.message).toBe("S-0001 already has this text; use it")
  })

  test("near-duplicate state text warns", async () => {
    const r = await run(
      Effect.andThen(
        call("add-state", { text: "the payment form is shown now" }),
        call("add-state", { text: "the payment form is shown" }),
      ),
    )
    expect(r.warnings.map((w) => w.code)).toEqual(["near-duplicate-state"])
  })

  test("removing a used state is refused with the cards that use it", async () => {
    const err = await run(Effect.andThen(pricing, Effect.flip(call("remove", { id: "S-0004" }))))
    expect(err._tag === "ToolError" && err.message).toBe("S-0004 is used by UX-0003, UX-0004, UX-0005; relink or remove them first")
  })

  test("link arrives replaces the current arrival", async () => {
    const text = await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("link", { card: "UX-0003", edge: "arrives", state: { id: "S-0001" } })
        return yield* PluginHost.use((h) => h.render(new Set(["UX-0003"])))
      }),
    )
    expect(text).toContain("Given the visitor is on the home page  # S-0001")
    expect(text).not.toContain("S-0002")
  })

  test("unlink removes a then edge", async () => {
    const r = await run(Effect.andThen(pricing, call("unlink", { card: "UX-0004", edge: "then", state: "S-0005" })))
    expect(r.changed).toEqual(["UX-0004"])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/plugin-gherkin && mise exec -- bun test`
Expected: FAIL, cannot resolve `../src/server`.

- [ ] **Step 4: Implement the model and lints**

`packages/plugin-gherkin/src/server/model.ts`:

```ts
import { Schema } from "effect"
import { type Node, Snapshot } from "@zarg/graph"

export const STATE = "gherkin/state"
export const CARD = "gherkin/card"
export const ARRIVES = "gherkin/arrives"
export const GIVEN = "gherkin/given"
export const THEN = "gherkin/then"

export const StateProps = Schema.Struct({
  text: Schema.NonEmptyString,
  /** A state the user can start from; no card needs to lead here. */
  entry: Schema.optionalKey(Schema.Boolean),
  /** A final outcome; no card needs to continue from here. */
  terminal: Schema.optionalKey(Schema.Boolean),
})

export const CardProps = Schema.Struct({
  title: Schema.NonEmptyString,
  when: Schema.NonEmptyString,
})

export const text = (n: Node): string => String(n.props.text ?? "")

/** Lowercase, single spaces, no trailing period: the form used to compare state text. */
export const normalize = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ").replace(/\.$/, "")

export const states = (snap: Snapshot.Snapshot) => Snapshot.byType(snap, STATE)
export const cards = (snap: Snapshot.Snapshot) => Snapshot.byType(snap, CARD)

export const findStateByText = (snap: Snapshot.Snapshot, t: string): Node | undefined =>
  states(snap).find((s) => normalize(text(s)) === normalize(t))

const words = (s: string) => new Set(normalize(s).split(" "))

/** Word-set overlap in [0, 1]. */
export const similarity = (a: string, b: string): number => {
  const x = words(a)
  const y = words(b)
  const both = [...x].filter((w) => y.has(w)).length
  return both / (x.size + y.size - both)
}
```

`packages/plugin-gherkin/src/server/lints.ts`:

```ts
import type { Node } from "@zarg/graph"
import type { Finding, Lint } from "@zarg/plugin/server"
import { CARD, normalize, similarity, STATE, states, text } from "./model"

const MAX_WORDS = 15

const clauses = (n: Node): ReadonlyArray<string> =>
  n.type === STATE ? [text(n)] : n.type === CARD ? [String(n.props.when ?? "")] : []

const touched: (ctx: Parameters<Lint>[0]) => ReadonlyArray<Node> = ({ diff }) => [
  ...diff.added,
  ...diff.changed.map((c) => c.after),
]

/** One atomic fact per clause: short, no conditions, no "and" chaining. */
export const clauseShape: Lint = (ctx) =>
  touched(ctx).flatMap((n) =>
    clauses(n).flatMap((c): ReadonlyArray<Finding> => {
      const out: Array<Finding> = []
      const count = c.trim().split(/\s+/).length
      if (count > MAX_WORDS) {
        out.push({ severity: "error", code: "clause-too-long", message: `${n.id}: "${c}" has ${count} words; keep clauses to ${MAX_WORDS} or fewer`, about: [n.id] })
      }
      if (/\bif\b/i.test(c)) {
        out.push({ severity: "error", code: "conditional", message: `${n.id}: "${c}" contains "if"; make one card per case instead`, about: [n.id] })
      }
      if (/\band\b/i.test(c)) {
        out.push({ severity: "warn", code: "and-chaining", message: `${n.id}: "${c}" contains "and"; split it if it states two facts`, about: [n.id] })
      }
      return out
    }),
  )

/** State text must be unique; near-identical text is probably the same state. */
export const stateText: Lint = (ctx) =>
  touched(ctx)
    .filter((n) => n.type === STATE)
    .flatMap((n): ReadonlyArray<Finding> =>
      states(ctx.after)
        .filter((o) => o.id !== n.id)
        .flatMap((o): ReadonlyArray<Finding> => {
          if (normalize(text(o)) === normalize(text(n))) {
            return [{ severity: "error", code: "duplicate-state", message: `${n.id} repeats the text of ${o.id}; reuse ${o.id}`, about: [n.id, o.id] }]
          }
          if (similarity(text(o), text(n)) >= 0.8) {
            return [{ severity: "warn", code: "near-duplicate-state", message: `${n.id} "${text(n)}" is close to ${o.id} "${text(o)}"; merge them if they mean the same`, about: [n.id, o.id] }]
          }
          return []
        }),
    )
```

- [ ] **Step 5: Implement the tools**

`packages/plugin-gherkin/src/server/tools.ts`:

```ts
import { Effect, Schema } from "effect"
import { type Change, type Node, Put, Remove, Snapshot } from "@zarg/graph"
import { tool, ToolError } from "@zarg/plugin/server"
import { ARRIVES, CARD, findStateByText, GIVEN, STATE, THEN } from "./model"

/** Point at an existing state by id, or describe one by text (reused if the text already exists). */
const StateRef = Schema.Union([Schema.Struct({ id: Schema.String }), Schema.Struct({ text: Schema.NonEmptyString })])
type StateRef = typeof StateRef.Type

const EdgeName = Schema.Literals(["arrives", "given", "then"])
const edgeType = { arrives: ARRIVES, given: GIVEN, then: THEN } as const

/** Resolves refs against a working snapshot, creating new states as needed. */
const resolver = (snap: Snapshot.Snapshot) => {
  let working = snap
  const created: Array<Node> = []
  const resolve = (ref: StateRef): Effect.Effect<string, ToolError> => {
    if ("id" in ref) {
      const n = working.nodes.get(ref.id)
      return n?.type === STATE ? Effect.succeed(ref.id) : Effect.fail(new ToolError({ message: `${ref.id} is not a state` }))
    }
    const existing = findStateByText(working, ref.text)
    if (existing !== undefined) return Effect.succeed(existing.id)
    const node: Node = { id: Snapshot.nextId(working, "S"), type: STATE, props: { text: ref.text }, edges: [] }
    created.push(node)
    working = Snapshot.applyChanges(working, [Put(node)])
    return Effect.succeed(node.id)
  }
  return { resolve, created, next: (prefix: string) => Snapshot.nextId(working, prefix) }
}

const getNode = (snap: Snapshot.Snapshot, id: string, type: string) => {
  const n = snap.nodes.get(id)
  return n?.type === type ? Effect.succeed(n) : Effect.fail(new ToolError({ message: `${id} is not a ${type}` }))
}

const createdNote = (created: ReadonlyArray<Node>) =>
  created.length === 0 ? "" : `; new states ${created.map((s) => s.id).join(", ")}`

export const addState = tool({
  name: "add-state",
  description: "Add a state (a Given/Then sentence). Fails if a state with the same text exists.",
  params: Schema.Struct({
    text: Schema.NonEmptyString,
    entry: Schema.optionalKey(Schema.Boolean),
    terminal: Schema.optionalKey(Schema.Boolean),
  }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const existing = findStateByText(snap, p.text)
      if (existing !== undefined) return yield* new ToolError({ message: `${existing.id} already has this text; use it` })
      const id = Snapshot.nextId(snap, "S")
      return { changes: [Put({ id, type: STATE, props: { ...p }, edges: [] })], message: `created ${id}` }
    }),
})

export const editState = tool({
  name: "edit-state",
  description: "Reword a state or change its entry/terminal flags. Every card using it updates.",
  params: Schema.Struct({
    id: Schema.String,
    text: Schema.optionalKey(Schema.NonEmptyString),
    entry: Schema.optionalKey(Schema.Boolean),
    terminal: Schema.optionalKey(Schema.Boolean),
  }),
  run: ({ id, ...patch }, snap) =>
    Effect.map(getNode(snap, id, STATE), (n) => ({
      changes: [Put({ ...n, props: { ...n.props, ...patch } })],
      message: `updated ${id}`,
    })),
})

export const addCard = tool({
  name: "add-card",
  description: "Add a card: one arrival Given, up to 3 extra Givens, one When, 1-5 Thens. States by {id} or {text}.",
  params: Schema.Struct({
    title: Schema.NonEmptyString,
    when: Schema.NonEmptyString,
    arrives: StateRef,
    given: Schema.optionalKey(Schema.Array(StateRef)),
    then: Schema.Array(StateRef),
  }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const r = resolver(snap)
      const arrives = yield* r.resolve(p.arrives)
      const given = yield* Effect.forEach(p.given ?? [], r.resolve)
      const then = yield* Effect.forEach(p.then, r.resolve)
      const id = r.next("UX")
      const card: Node = {
        id,
        type: CARD,
        props: { title: p.title, when: p.when },
        edges: [
          { type: ARRIVES, to: arrives },
          ...given.map((to) => ({ type: GIVEN, to })),
          ...then.map((to) => ({ type: THEN, to })),
        ],
      }
      return { changes: [...r.created.map(Put), Put(card)], message: `created ${id}${createdNote(r.created)}` }
    }),
})

export const editCard = tool({
  name: "edit-card",
  description: "Change a card's title or When.",
  params: Schema.Struct({
    id: Schema.String,
    title: Schema.optionalKey(Schema.NonEmptyString),
    when: Schema.optionalKey(Schema.NonEmptyString),
  }),
  run: ({ id, ...patch }, snap) =>
    Effect.map(getNode(snap, id, CARD), (n) => ({
      changes: [Put({ ...n, props: { ...n.props, ...patch } })],
      message: `updated ${id}`,
    })),
})

export const link = tool({
  name: "link",
  description: "Connect a card to a state as arrives (replaces the current one), given, or then.",
  params: Schema.Struct({ card: Schema.String, edge: EdgeName, state: StateRef }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const card = yield* getNode(snap, p.card, CARD)
      const r = resolver(snap)
      const to = yield* r.resolve(p.state)
      const type = edgeType[p.edge]
      if (card.edges.some((e) => e.type === type && e.to === to)) {
        return yield* new ToolError({ message: `${p.card} already has ${p.edge} ${to}` })
      }
      const kept = p.edge === "arrives" ? card.edges.filter((e) => e.type !== ARRIVES) : card.edges
      const changes: Array<Change> = [...r.created.map(Put), Put({ ...card, edges: [...kept, { type, to }] })]
      return { changes, message: `linked ${p.card} ${p.edge} ${to}${createdNote(r.created)}` }
    }),
})

export const unlink = tool({
  name: "unlink",
  description: "Remove a given or then edge from a card.",
  params: Schema.Struct({ card: Schema.String, edge: EdgeName, state: Schema.String }),
  run: (p, snap) =>
    Effect.gen(function* () {
      const card = yield* getNode(snap, p.card, CARD)
      const type = edgeType[p.edge]
      const edges = card.edges.filter((e) => !(e.type === type && e.to === p.state))
      if (edges.length === card.edges.length) {
        return yield* new ToolError({ message: `${p.card} has no ${p.edge} ${p.state}` })
      }
      return { changes: [Put({ ...card, edges })], message: `unlinked ${p.card} ${p.edge} ${p.state}` }
    }),
})

export const remove = tool({
  name: "remove",
  description: "Remove a card, or a state that no card uses.",
  params: Schema.Struct({ id: Schema.String }),
  run: ({ id }, snap) =>
    Effect.gen(function* () {
      const n = snap.nodes.get(id)
      if (n === undefined) return yield* new ToolError({ message: `no node ${id}` })
      const users = Snapshot.inbound(snap, id).map((e) => e.from)
      if (users.length > 0) {
        return yield* new ToolError({ message: `${id} is used by ${[...new Set(users)].join(", ")}; relink or remove them first` })
      }
      return { changes: [Remove(id)], message: `removed ${id}` }
    }),
})

export const tools = [addState, editState, addCard, editCard, link, unlink, remove]
```

- [ ] **Step 6: Implement agenda, render and the plugin**

`packages/plugin-gherkin/src/server/agenda.ts`:

```ts
import { Snapshot } from "@zarg/graph"
import type { AgendaItem } from "@zarg/plugin/server"
import { ARRIVES, cards, similarity, states, text, THEN } from "./model"

export const agenda = (snap: Snapshot.Snapshot): ReadonlyArray<AgendaItem> => {
  const all = states(snap)
  if (all.length === 0 && cards(snap).length === 0) {
    return [{
      id: "gherkin:empty",
      title: "No requirements yet",
      detail: "Describe where a user starts and their first action.",
      about: [],
      priority: 1,
    }]
  }
  const items: Array<AgendaItem> = []
  for (const s of all) {
    if (s.props.terminal !== true && Snapshot.inbound(snap, s.id, ARRIVES).length === 0) {
      items.push({
        id: `gherkin:dead-end:${s.id}`,
        title: `What can the user do when "${text(s)}"?`,
        detail: `No card continues from ${s.id}. Add a card that arrives there, or mark it terminal.`,
        about: [s.id],
        priority: 2,
      })
    }
    if (s.props.entry !== true && Snapshot.inbound(snap, s.id, THEN).length === 0) {
      items.push({
        id: `gherkin:unreached:${s.id}`,
        title: `How does the user reach "${text(s)}"?`,
        detail: `No card leads to ${s.id}. Add a card whose Then is ${s.id}, or mark it an entry state.`,
        about: [s.id],
        priority: 2,
      })
    }
  }
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) {
      if (similarity(text(a), text(b)) >= 0.8) {
        items.push({
          id: `gherkin:near-duplicate:${a.id}:${b.id}`,
          title: `Are "${text(a)}" and "${text(b)}" the same state?`,
          detail: `${a.id} and ${b.id} have nearly the same text.`,
          about: [a.id, b.id],
          priority: 3,
        })
      }
    }
  }
  return items
}
```

`packages/plugin-gherkin/src/server/render.ts`:

```ts
import { type Node, Snapshot } from "@zarg/graph"
import { ARRIVES, cards, GIVEN, states, text, THEN } from "./model"

const line = (keyword: string, snap: Snapshot.Snapshot, id: string) =>
  `  ${keyword.padEnd(5)} ${text(snap.nodes.get(id)!)}  # ${id}`

const renderCard = (snap: Snapshot.Snapshot, card: Node): string => {
  const targets = (type: string) => Snapshot.out(snap, card.id, type).map((e) => e.to)
  const givens = [...targets(ARRIVES), ...targets(GIVEN)]
  const thens = targets(THEN)
  return [
    `${card.id} ${String(card.props.title)}`,
    ...givens.map((id, i) => line(i === 0 ? "Given" : "And", snap, id)),
    `  When  ${String(card.props.when)}`,
    ...thens.map((id, i) => line(i === 0 ? "Then" : "And", snap, id)),
  ].join("\n")
}

/** Gherkin text for every card (or those touching `focus`), then states no card uses. */
export const render = (snap: Snapshot.Snapshot, focus?: ReadonlySet<string>): string => {
  const shown = cards(snap).filter(
    (c) => focus === undefined || focus.has(c.id) || c.edges.some((e) => focus.has(e.to)),
  )
  const unused = states(snap).filter(
    (s) => Snapshot.inbound(snap, s.id).length === 0 && (focus === undefined || focus.has(s.id)),
  )
  const parts = shown.map((c) => renderCard(snap, c))
  if (unused.length > 0) parts.push(["States without cards:", ...unused.map((s) => `  ${s.id} ${text(s)}`)].join("\n"))
  return parts.join("\n\n")
}
```

`packages/plugin-gherkin/src/server/index.ts`:

```ts
import { server } from "@zarg/plugin/server"
import { agenda } from "./agenda"
import { clauseShape, stateText } from "./lints"
import { CardProps, StateProps } from "./model"
import { render } from "./render"
import { tools } from "./tools"

export const gherkin = server({
  name: "gherkin",
  nodes: { state: StateProps, card: CardProps },
  edges: {
    arrives: { from: "card", to: "state", min: 1, max: 1 },
    given: { from: "card", to: "state", max: 3 },
    then: { from: "card", to: "state", min: 1, max: 5 },
  },
  lints: [clauseShape, stateText],
  tools,
  agenda,
  render,
})

export * from "./model"
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/plugin-gherkin && mise exec -- bun test`
Expected: PASS, 16 tests.

- [ ] **Step 8: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/plugin-gherkin bun.lock
git commit -m "feat(gherkin): user action graph plugin with states, cards, lints and agenda

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The `zarg` CLI

**Files:**
- Move: `packages/cli/src/index.ts` to `packages/cli/src/tui.ts` (then rewrite it)
- Create: `packages/cli/src/{main.ts,commands.ts,git.ts,plugins.ts,root.ts}`
- Create: `packages/cli/test/cli.test.ts`
- Modify: `packages/cli/package.json`

**Interfaces:**
- Consumes: `layer`, `GraphStore`, `diff`, `hash`, `Snapshot`, `Node`, `IoError` from `@zarg/graph`; `layer`, `PluginHost`, `ServerPlugin` from `@zarg/plugin/server`; `gherkin` from `@zarg/plugin-gherkin/server`.
- Produces: commands `tool list`, `tool call <name> <params-json> [--expect id@hash,...]`, `show <id>`, `render [--focus id] [--k n]`, `agenda [--focus id] [--k n]`, `lint`, `query neighbors <id> [--k n]`, `query code <id>`, `diff --since <ref>`, `tui`.
  - Output is JSON on stdout (`render` prints text).
  - Failures print `{ "error": <tag>, ...fields }` to stderr and exit with code 1.
  - The graph lives in `$ZARG_ROOT/.zarg/graph`, with the working directory as the default root. Run it as `mise run -q zarg -- <command>`.
  - Do not use `bun run zarg`: bun does not link workspace bins at the root, so it finds no `zarg` script.

- [ ] **Step 1: Dependencies and bin**

```bash
git mv packages/cli/src/index.ts packages/cli/src/tui.ts
cd packages/cli && mise exec -- bun add effect@rc @effect/platform-bun@rc && cd ../..
```

Replace `packages/cli/mise.toml` with (adds the `test` task):

```toml
[tasks.typecheck]
run = "bunx tsc"

[tasks.test]
run = "bun test"
```

Edit `packages/cli/package.json` so it reads:

```json
{
  "name": "@zarg/cli",
  "dependencies": {
    "@effect/platform-bun": "^4.0.0-rc.117",
    "@opentui/core": "^0.5.12",
    "@zarg/graph": "workspace:*",
    "@zarg/plugin": "workspace:*",
    "@zarg/plugin-gherkin": "workspace:*",
    "effect": "^4.0.0-rc.117"
  },
  "bin": {
    "zarg": "src/main.ts"
  },
  "private": true,
  "type": "module"
}
```

Then run `mise exec -- bun install` at the root.

- [ ] **Step 2: Write the failing tests**

`packages/cli/test/cli.test.ts` (runs the real CLI in a temp git repo):

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const main = join(import.meta.dir, "../src/main.ts")
let dir = ""

const zarg = (...args: Array<string>) => {
  const p = Bun.spawnSync(["bun", main, ...args], { cwd: dir, env: { ...process.env, ZARG_ROOT: dir } })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const json = (...args: Array<string>) => JSON.parse(zarg(...args).out)
const git = (...args: Array<string>) =>
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zarg-cli-"))
  git("init", "-q")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("zarg cli", () => {
  test("tool call writes the graph and render shows it", () => {
    expect(json("tool", "call", "gherkin/add-state", '{"text":"the home page is shown","entry":true}').added).toEqual(["S-0001"])
    const r = json("tool", "call", "gherkin/add-card", JSON.stringify({ title: "Open pricing", when: "the user clicks Pricing", arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown" }] }))
    expect(r.message).toBe("created UX-0001; new states S-0002")
    expect(zarg("render").out).toContain("Then  the plan picker is shown  # S-0002")
  })

  test("show returns the node, its hash and inbound edges", () => {
    const s = json("show", "S-0002")
    expect(s.node.props.text).toBe("the plan picker is shown")
    expect(s.hash).toMatch(/^[0-9a-f]{12}$/)
    expect(s.inbound).toEqual([{ from: "UX-0001", type: "gherkin/then" }])
  })

  test("failures are JSON on stderr with exit code 1", () => {
    const r = zarg("tool", "call", "gherkin/add-state", '{"text":"shown if paid"}')
    expect(r.code).toBe(1)
    const e = JSON.parse(r.err)
    expect(e.error).toBe("LintFailed")
    expect(e.findings[0].code).toBe("conditional")
  })

  test("--expect rejects a stale hash", () => {
    const r = zarg("tool", "call", "gherkin/edit-state", '{"id":"S-0002","text":"plans are listed"}', "--expect", "S-0002@000000000000")
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).error).toBe("StaleNode")
  })

  test("diff --since compares a git ref with the working tree", () => {
    git("add", ".zarg")
    git("commit", "-qm", "graph")
    zarg("tool", "call", "gherkin/edit-state", '{"id":"S-0002","text":"the plans are listed"}')
    const d = json("diff", "--since", "HEAD")
    expect(d.changed.map((c: { id: string }) => c.id)).toEqual(["S-0002"])
    expect(d.added).toEqual([])
  })

  test("agenda and focus", () => {
    const ids = json("agenda").map((i: { id: string }) => i.id)
    expect(ids).toEqual(["gherkin:dead-end:S-0002"])
    expect(json("query", "neighbors", "S-0001", "--k", "1")).toEqual(["S-0001", "UX-0001"])
  })

  test("query code finds @card tags in tracked files", async () => {
    await Bun.write(join(dir, "app.ts"), "// @card UX-0001\n")
    git("add", "app.ts")
    expect(json("query", "code", "UX-0001")).toEqual(["app.ts:1:// @card UX-0001"])
    expect(json("query", "code", "UX-0002")).toEqual([])
  })

  test("a malformed --expect is an error, not ignored", () => {
    const r = zarg("tool", "call", "gherkin/edit-state", '{"id":"S-0002","text":"x y"}', "--expect", "S-0002")
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).message).toContain("id@hash")
  })

  test("diff --since a ref without a graph reports everything as added; a bad ref is an error", () => {
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    expect(json("diff", "--since", emptyTree).added.map((n: { id: string }) => n.id)).toEqual(["S-0001", "S-0002", "UX-0001"])
    const r = zarg("diff", "--since", "no-such-ref")
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).error).toBe("IoError")
  })

  test("a broken node file shows up on the agenda and other commands keep working", async () => {
    await Bun.write(join(dir, ".zarg/graph/nodes/S-0099.json"), "{ broken")
    const ids = json("agenda").map((i: { id: string }) => i.id)
    expect(ids[0]).toContain("invalid-file:")
    expect(zarg("render").code).toBe(0)
    rmSync(join(dir, ".zarg/graph/nodes/S-0099.json"))
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/cli && mise exec -- bun test`
Expected: FAIL, `src/main.ts` does not exist.

- [ ] **Step 4: Implement the CLI**

`packages/cli/src/tui.ts`:

```ts
import { TextRenderable, createCliRenderer } from "@opentui/core"

/** Placeholder shell until phase 3 builds the real client. */
export const runTui = async () => {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  renderer.root.add(new TextRenderable(renderer, { content: "zarg" }))
}
```

`packages/cli/src/root.ts`:

```ts
/** Project root: `ZARG_ROOT` when set, else the working directory. The graph lives in `<root>/.zarg/graph`. */
export const root = process.env.ZARG_ROOT ?? process.cwd()
export const graphDir = `${root}/.zarg/graph`
```

`packages/cli/src/plugins.ts`:

```ts
import { gherkin } from "@zarg/plugin-gherkin/server"
import type { ServerPlugin } from "@zarg/plugin/server"

/** Plugins the CLI hosts. Add new plugins here. */
export const plugins: ReadonlyArray<ServerPlugin> = [gherkin]
```

`packages/cli/src/git.ts`:

```ts
import { Effect, Schema } from "effect"
import { IoError, Node, Snapshot } from "@zarg/graph"

const sh = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => Bun.$`git ${args}`.cwd(cwd).quiet().text(),
    catch: (e) => new IoError({ path: cwd, message: `git ${args.join(" ")}: ${String(e)}` }),
  })

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Node))

/** The graph as committed at `ref`, read with git (the working tree is untouched). */
export const snapshotAt = (root: string, ref: string) =>
  Effect.gen(function* () {
    const listing = yield* sh(root, ["ls-tree", "-r", "--name-only", ref, "--", ".zarg/graph/nodes"])
    const files = listing.split("\n").filter((f) => f.endsWith(".json"))
    const nodes = yield* Effect.forEach(files, (file) =>
      sh(root, ["show", `${ref}:${file}`]).pipe(
        Effect.flatMap(decode),
        Effect.mapError((e) => new IoError({ path: file, message: e.message })),
      ),
    )
    return Snapshot.make(nodes)
  })

/** `path:line:text` hits for `@card <id>` in tracked files. */
export const cardRefs = (root: string, id: string) =>
  sh(root, ["grep", "-n", "-w", "-e", `@card ${id}`]).pipe(
    Effect.map((out) => out.split("\n").filter((l) => l.length > 0)),
    // git grep exits 1 when nothing matches.
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
  )
```

`packages/cli/src/commands.ts`:

```ts
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { diff, GraphStore, hash, Snapshot } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { cardRefs, snapshotAt } from "./git"
import { root } from "./root"

const print = (value: unknown) => Console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))

const k = Flag.Int("k").pipe(Flag.withDefault(3), Flag.withDescription("hops for --focus / neighbors"))
const focus = Flag.String("focus").pipe(Flag.optional, Flag.withDescription("limit to nodes within --k hops of this id"))

const focusSet = (id: Option.Option<string>, hops: number) =>
  Option.match(id, {
    onNone: () => Effect.succeed(undefined),
    onSome: (id) => Effect.map(GraphStore.use((s) => s.snapshot), (snap) => new Set(Snapshot.neighbors(snap, id, hops))),
  })

/** `--expect S-0001@3f2a9c1b0e4d,UX-0003@absent` */
const parseExpect = (raw: Option.Option<string>) =>
  Effect.forEach(
    Option.match(raw, { onNone: () => [], onSome: (s) => s.split(",") }),
    (pair) => {
      const [id, h] = pair.split("@")
      return id && h ? Effect.succeed([id, h] as const) : Effect.fail(new Error(`--expect wants id@hash, got "${pair}"`))
    },
  ).pipe(Effect.map(Object.fromEntries))

const toolList = Command.make("list", {}, () => PluginHost.use((h) => print(h.tools)))

const toolCall = Command.make("call",
  {
    name: Argument.String("name"),
    params: Argument.String("params-json"),
    expect: Flag.String("expect").pipe(Flag.optional, Flag.withDescription("id@hash pairs that must still hold")),
  },
  ({ name, params, expect }) =>
    Effect.gen(function* () {
      const raw = yield* Effect.try({
        try: () => JSON.parse(params) as unknown,
        catch: () => new Error(`params must be JSON, got: ${params}`),
      })
      const expected = yield* parseExpect(expect)
      const result = yield* PluginHost.use((h) => h.call(name, raw, expected))
      yield* print(result)
    }),
)

const tool = Command.make("tool").pipe(Command.withSubcommands([toolList, toolCall]))

const show = Command.make("show", { id: Argument.String("id") }, ({ id }) =>
  Effect.gen(function* () {
    const snap = yield* GraphStore.use((s) => s.snapshot)
    const node = snap.nodes.get(id)
    if (node === undefined) return yield* Effect.fail(new Error(`no node ${id}`))
    const inbound = Snapshot.inbound(snap, id).map((e) => ({ from: e.from, type: e.edge.type }))
    yield* print({ node, hash: hash(node), inbound })
  }),
)

const render = Command.make("render", { focus, k }, (o) =>
  Effect.flatMap(focusSet(o.focus, o.k), (f) => PluginHost.use((h) => Effect.flatMap(h.render(f), print))),
)

const agenda = Command.make("agenda", { focus, k }, (o) =>
  Effect.flatMap(focusSet(o.focus, o.k), (f) => PluginHost.use((h) => Effect.flatMap(h.agenda(f), print))),
)

const lint = Command.make("lint", {}, () => PluginHost.use((h) => Effect.flatMap(h.lint, print)))

const neighbors = Command.make("neighbors", { id: Argument.String("id"), k }, (o) =>
  Effect.flatMap(GraphStore.use((s) => s.snapshot), (snap) => print(Snapshot.neighbors(snap, o.id, o.k))),
)

const code = Command.make("code", { id: Argument.String("id") }, ({ id }) => Effect.flatMap(cardRefs(root, id), print))

const query = Command.make("query").pipe(Command.withSubcommands([neighbors, code]))

const diffCmd = Command.make("diff", { since: Flag.String("since").pipe(Flag.withDescription("git ref")) }, ({ since }) =>
  Effect.gen(function* () {
    const before = yield* snapshotAt(root, since)
    const after = yield* GraphStore.use((s) => s.snapshot)
    yield* print(diff(before, after))
  }),
)

const tui = Command.make("tui", {}, () => Effect.promise(() => import("./tui").then((m) => m.runTui())))

export const zarg = Command.make("zarg").pipe(
  Command.withSubcommands([tool, show, render, agenda, lint, query, diffCmd, tui]),
)
```

`packages/cli/src/main.ts`:

```ts
#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { CliError, Command } from "effect/unstable/cli"
import { layer as graphLayer } from "@zarg/graph"
import { layer as hostLayer } from "@zarg/plugin/server"
import { zarg } from "./commands"
import { plugins } from "./plugins"
import { graphDir } from "./root"

const services = Layer.provideMerge(hostLayer(plugins), graphLayer(graphDir)).pipe(
  Layer.provideMerge(BunServices.layer),
)

/** Command failures go to stderr as `{ "error": <tag>, ...fields }` with exit code 1, so agents can act on them. */
const report = (e: unknown) => {
  if (CliError.isCliError(e)) return Effect.fail(e)
  const { _tag, ...fields } = e as { _tag?: string }
  const message = e instanceof Error && e.message !== "" ? { message: e.message } : {}
  return Effect.andThen(
    Console.error(JSON.stringify({ error: _tag ?? "Error", ...fields, ...message }, null, 2)),
    Effect.sync(() => {
      process.exitCode = 1
    }),
  )
}

Command.run(zarg, { version: "0.0.0" }).pipe(Effect.catch(report), Effect.provide(services), BunRuntime.runMain)
```

```bash
chmod +x packages/cli/src/main.ts
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/cli && mise exec -- bun test`
Expected: PASS, 10 tests.

- [ ] **Step 6: Smoke test by hand**

```bash
mise run -q zarg -- --help
mise run -q zarg -- agenda
```

Expected: help lists `tool show render agenda lint query diff tui`. The agenda prints `gherkin:empty` (this repo has no graph yet). Delete `.zarg` if the smoke test created it: `rm -rf .zarg`.

- [ ] **Step 7: Gate and commit**

Run: `mise run verify` (expected exit 0, 63 tests across 4 packages), then:

```bash
git add packages/cli bun.lock
git commit -m "feat(cli): zarg graph commands with JSON output and JSON errors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Skills, agent guide, and the dogfood run

**Files:**
- Create: `.claude/skills/zarg-drive/SKILL.md`, `.claude/skills/zarg-sync/SKILL.md`
- Modify: `AGENTS.md`
- Create (during the run): `.zarg/graph/nodes/*.json`, `.zarg/sync.json`

**Interfaces:**
- Consumes: the CLI from Task 6.
- Produces: skills that make Claude Code the driver and the sync agent for this repo.

- [ ] **Step 1: Write the skills**

`.claude/skills/zarg-drive/SKILL.md`:

````markdown
---
name: zarg-drive
description: Drive the product-requirements conversation for this repo through the zarg requirements graph. Use when the user wants to work on requirements, says "drive", "what's next", or asks to add or change product behavior.
---

# zarg-drive

You are the driver. You lead the conversation about what the product should do, and you record every decision in the requirements graph under `.zarg/graph`. You never edit code; the `zarg-sync` skill does that.

Run the CLI from the repo root as `mise run -q zarg -- <command>`. Output is JSON on stdout. Failures are JSON on stderr with exit code 1.

## The model

- A **state** (`S-NNNN`) is one Given/Then sentence, stored once.
- A **card** (`UX-NNNN`) is one user action: it arrives from exactly one state (Given), may need up to 3 extra context states (And), has exactly one When, and leads to 1-5 states (Then).
- A choice ("option A, B or N") is several cards that share one arrival state.
- An outcome branch (success, failure) is one card per outcome, each with its own When.
- Mark a state `entry` when the user can start there, `terminal` when nothing needs to follow it.
- Clauses have at most 15 words, never contain "if" (make one card per case), and avoid "and".

## Loop

1. Read the agenda: `mise run -q zarg -- agenda`. When the user named a topic, add `--focus <id>` for the nearest node.
2. Pick the top item (lowest `priority`), or the user's topic.
3. Research it: `render --focus <id>`, `show <id>`, `query neighbors <id>`, and read-only looks at the code. Understand before asking.
4. Ask one question with `AskUserQuestion`:
   - 2-4 concrete options. Put your recommendation first, label it "(Recommended)", and say why in its description.
   - Show the affected cards (from `render`) in the question when it helps.
   - The user can always pick "Other" to type their own idea. Treat that answer as seriously as an option.
   - Never ask an empty question like "what do you want?". If you are unsure, still bring options.
5. Apply the answer with `tool call`. Run `tool list` once to see every tool and its params. Common ones:
   - `gherkin/add-card '{"title":"...","when":"...","arrives":{"id":"S-0002"},"then":[{"text":"..."}]}'` (a state is `{"id":...}` to reuse or `{"text":...}` to create; existing text is reused automatically)
   - `gherkin/edit-state '{"id":"S-0002","text":"...","terminal":true}'`
   - `gherkin/link`, `gherkin/unlink`, `gherkin/edit-card`, `gherkin/remove`
   - When you change a node you looked at earlier, pass `--expect <id>@<hash>` with the hash from `show`.
6. Handle failures by their `error` field:
   - `LintFailed`: follow each finding's message (shorten, split, drop "if") and retry.
   - `ToolError`: follow the message.
   - `StaleNode`: someone else changed the node. Run `show` again and compare what you read, what is there now, and what you wanted. If the merge is obvious, apply it and tell the user. If not, ask with `AskUserQuestion`: merged version (Recommended, with why), keep theirs, keep mine.
7. Show the user the rendered result in a few lines, then go back to step 1.

When the agenda is empty, ask "what next?" with options drawn from the graph (unexplored branches, missing failure cases, the next user journey).

## Rules

- Never edit `.zarg/graph` files by hand and never edit code.
- Reuse states by id whenever the meaning is the same.
- At natural stopping points, offer to commit the graph: `git add .zarg/graph && git commit -m "req: <summary>"`.
- Stop when the user says so.
````

`.claude/skills/zarg-sync/SKILL.md`:

````markdown
---
name: zarg-sync
description: Sync this repo's code to the zarg requirements graph. Use when the user says "sync", "implement the graph", or requirements changed and the code must catch up.
---

# zarg-sync

You are the sync agent. You make the code match the requirements graph under `.zarg/graph`. You never change requirements; the `zarg-drive` skill does that.

Run the CLI from the repo root as `mise run -q zarg -- <command>`.

## Steps

1. The graph must be committed. If `git status --porcelain .zarg/graph` prints anything, ask the user whether to commit it (`git commit -m "req: ..."`) before continuing.
2. Note the current commit: `TARGET=$(git rev-parse HEAD)`.
3. Find the last synced commit in `.zarg/sync.json` (`{"graph": "<sha>"}`). If the file does not exist, use the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
4. Get the changes: `mise run -q zarg -- diff --since <sha>`. If `added`, `removed` and `changed` are all empty, report "in sync" and stop.
5. Work out which cards are affected:
   - every added, changed or removed `gherkin/card`
   - for every changed state, the cards that use it: `show <state-id>` lists them under `inbound`
6. For each affected card:
   - Read it: `render --focus <id> --k 1`.
   - Find its current code: `query code <id>`.
   - Implement or adjust the behavior test-first. Tag the implementation and its tests with a `// @card <id>` comment.
   - For a removed card, delete its code and tags.
7. If a card cannot be implemented as written (it contradicts another card, or is missing information), do not guess and do not edit the graph. Stop and tell the user which card and why, and suggest running `zarg-drive` on it.
8. Run `mise run verify`. It must pass.
9. Write `{"graph": "<TARGET>"}` to `.zarg/sync.json` and commit it together with the code: `git commit -m "feat: sync <card ids>"`.
````

- [ ] **Step 2: Update the agent guide**

Replace `AGENTS.md` with:

````markdown
# Agent Guide

Rules for any agent (Claude, Codex, etc.) working in this repo.

## Toolchain

- **mise** manages every tool version. `mise.toml` is the source of truth.
- **bun** is the JavaScript runtime, package manager, test runner, and script runner.

## Layout

Monorepo. Every module lives in its own package under `packages/<name>/`.

```
mise.toml        # tool versions + monorepo root (config_roots = packages/*)
package.json     # bun workspaces = packages/*
packages/<name>/
  mise.toml      # this package's tasks (build, test, dev, ...)
  package.json   # name: @zarg/<name>
```

- One package = one module. No cross-package imports through relative paths; depend on the package by name (`"@zarg/<name>": "workspace:*"`).
- Tool versions live only in the root `mise.toml`. Package `mise.toml` files define tasks only.
- One `bun.lock` at the root. Run `bun install` from the root.

## Packages

- `packages/graph` (`@zarg/graph`): JSON graph store under `.zarg/graph`: snapshot, queries, diff.
- `packages/plugin` (`@zarg/plugin/server`): plugin contract, `PluginHost` and the write pipeline.
- `packages/plugin-gherkin` (`@zarg/plugin-gherkin/server`): atomic Gherkin user action graph (states and cards).
- `packages/cli` (`@zarg/cli`): the `zarg` CLI. Run it with `mise run -q zarg -- <command>`.

Design: `docs/superpowers/specs/2026-09-25-harness-architecture-design.md`.

## Requirements

This repo's requirements live in its own zarg graph under `.zarg/graph`.

- Use the `zarg-drive` skill (`.claude/skills/zarg-drive/SKILL.md`) to refine requirements. It edits only the graph.
- Use the `zarg-sync` skill (`.claude/skills/zarg-sync/SKILL.md`) to make code match the graph. It edits only code.
- Never edit `.zarg/graph` files by hand. Change them through `zarg tool call`.
- Tag code that implements a card with a `// @card <id>` comment (for example `// @card UX-0003`).

## Tasks

mise orchestrates tasks across packages:

```sh
mise tasks ls --all             # list every task in the monorepo
mise //packages/<name>:test     # one task in one package
mise //...:test                 # the same task in every package
```

A task depends on another package's task with `depends = ["//packages/<other>:build"]`.

## Setup

```sh
mise trust
mise install
```

## Rules

- Run tools through mise (`mise exec -- bun ...`) or in a shell with mise activated. Never rely on a globally installed tool version.
- Add or change a tool version only in `mise.toml`. Never document a version anywhere else.
- Use `bun`, never `npm`, `npx`, `yarn`, `pnpm`, or `node`. Use `bunx` in place of `npx`.
- Use `bun add` / `bun remove` to change dependencies. Commit `bun.lock`.
- Use `bun test` for tests and `bun run <script>` for package scripts.
- `mise run verify` typechecks and tests every package. It must pass before any commit.
- Define repeatable project commands as `[tasks]` in `mise.toml`, so humans and agents run the same thing (`mise run <task>`).
````

- [ ] **Step 3: Commit**

```bash
git add .claude/skills AGENTS.md
git commit -m "docs: zarg-drive and zarg-sync skills, requirements section in AGENTS.md

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Seed zarg's own requirements with the user (interactive)**

This step needs the user. Start a session, invoke the `zarg-drive` skill, and let it drive from the `gherkin:empty` agenda item. The goal is zarg's first user journeys: a user refines requirements in conversation, and code catches up. Commit the graph when the user is happy: `git add .zarg/graph && git commit -m "req: seed zarg requirements"`.

Expected: `mise run -q zarg -- lint` prints `[]`, and `mise run -q zarg -- render` shows the seeded cards.

- [ ] **Step 5: Phase 1 acceptance run (interactive)**

1. With `zarg-drive`, add one new requirement card that the current code does not satisfy, chosen with the user. Commit it as `req: ...`.
2. With `zarg-sync`, implement it. The skill tags the code with `// @card <id>`, runs `mise run verify`, writes `.zarg/sync.json` and commits.
3. Check: `mise run -q zarg -- query code <id>` lists the tagged files, and `mise run -q zarg -- diff --since <sha from .zarg/sync.json>` shows an empty diff.

Phase 1 is done when this run succeeds using only the two skills.
