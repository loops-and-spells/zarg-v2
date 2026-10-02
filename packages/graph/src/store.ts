import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { diff, type Diff } from "./diff"
import { DanglingEdge, InvalidNode, IoError, StaleNode, type GraphError } from "./errors"
import { hash } from "./hash"
import { canonical, Node } from "./node"
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
        const reserved = new Set(problems.map((p) => path.basename(p.file, ".json")))
        return { snapshot: make(nodes, reserved), problems }
      })

      const snapshot = Effect.map(load, (l) => l.snapshot)

      // @scenario S-0002
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
          for (const c of changes) {
            const id = c._tag === "Put" ? c.node.id : c.id
            if (before.reserved.has(id)) {
              return yield* new InvalidNode({ file: fileOf(id), message: `${id} failed to load; restore or fix the file first` })
            }
          }
          // @scenario S-0016
          for (const [id, expected] of Object.entries(expect)) {
            const cur = before.nodes.get(id)
            const actual = cur === undefined ? undefined : hash(cur)
            if ((actual ?? "absent") !== expected) return yield* new StaleNode({ id, expected, actual })
          }
          const after = applyChanges(before, changes)
          // Only edges this change introduces: a damaged file elsewhere must not block unrelated writes.
          const touched = new Set(changes.map((c) => (c._tag === "Put" ? c.node.id : c.id)))
          const dangling = danglingEdges(after).find((d) => touched.has(d.from) || touched.has(d.edge.to))
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
