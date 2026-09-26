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
