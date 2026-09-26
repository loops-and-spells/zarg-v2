import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Path } from "effect"
import { GraphStore, hash, layer, Put, Remove, Snapshot } from "../src"
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

  // @card UX-0002
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

  test("a damaged file's id is reserved: nextId skips it and commit will not overwrite it", async () => {
    const out = await withStore((dir) =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        const fs = yield* FileSystem.FileSystem
        yield* store.commit([Put(state("S-0001", "a")), Put(state("S-0002", "b"))])
        yield* fs.writeFileString(`${dir}/nodes/S-0002.json`, "{ broken")
        const next = Snapshot.nextId(yield* store.snapshot, "S")
        const err = yield* failure(store.commit([Put(state("S-0002", "unrelated"))]))
        const text = yield* fs.readFileString(`${dir}/nodes/S-0002.json`)
        return { next, tag: err._tag, text }
      }),
    )
    expect(out).toEqual({ next: "S-0003", tag: "InvalidNode", text: "{ broken" })
  })

  test("a damaged file blocks only changes that touch it", async () => {
    const out = await withStore((dir) =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        yield* store.commit([Put(state("S-0001", "a")), Put(card("UX-0001", "go", "S-0001", ["S-0001"]))])
        yield* (yield* FileSystem.FileSystem).writeFileString(`${dir}/nodes/S-0001.json`, "<<<<<<< HEAD")
        const ok = yield* store.commit([Put(state("S-0002", "b"))])
        const pointing = yield* failure(store.commit([Put(card("UX-0002", "go", "S-0001", ["S-0002"]))]))
        return { added: ok.diff.added.map((n) => n.id), pointing: pointing._tag }
      }),
    )
    expect(out).toEqual({ added: ["S-0002"], pointing: "DanglingEdge" })
  })

  test("removing a node that an untouched node points to is still refused", async () => {
    const err = await withStore(() =>
      Effect.gen(function* () {
        const store = yield* GraphStore
        yield* store.commit([Put(state("S-0001", "a")), Put(card("UX-0001", "go", "S-0001", ["S-0001"]))])
        return yield* failure(store.commit([Remove("S-0001")]))
      }),
    )
    expect(err._tag).toBe("DanglingEdge")
  })
})
