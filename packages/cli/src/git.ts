import { Effect, Schema } from "effect"
import { IoError, Node, Snapshot } from "@zarg/graph"

const sh = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => Bun.$`git ${args}`.cwd(cwd).quiet().text(),
    catch: (e) => new IoError({ path: cwd, message: `git ${args.join(" ")}: ${String(e)}` }),
  })

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Node))

/** The graph as committed at `ref`, read with git (the working tree is untouched). Undecodable files are skipped and reported. */
// @card UX-0005
export const snapshotAt = (root: string, ref: string) =>
  Effect.gen(function* () {
    // --full-name: paths from the repo top, which is what `git show ref:path` expects.
    const listing = yield* sh(root, ["ls-tree", "-r", "--full-name", "--name-only", ref, "--", ".zarg/graph/nodes"])
    const files = listing.split("\n").filter((f) => f.endsWith(".json"))
    const results = yield* Effect.forEach(files, (file) =>
      Effect.flatMap(sh(root, ["show", `${ref}:${file}`]), (text) =>
        decode(text).pipe(
          Effect.catch((e) => Effect.succeed({ file, message: e.message })),
        ),
      ),
    )
    const problems = results.filter((r): r is { file: string; message: string } => "file" in r)
    const nodes = results.filter((r): r is Node => !("file" in r))
    return { snapshot: Snapshot.make(nodes), problems }
  })

/** `path:line:text` hits for `@card <id>` in tracked and untracked files (not ignored ones). */
// @card UX-0081 UX-0082
export const cardRefs = (root: string, id: string) =>
  // The id anywhere in a tag's list: `@card UX-0081 UX-0082` is a tag for both.
  sh(root, ["grep", "-n", "--untracked", "-E", "-e", `@card([[:space:]]+[A-Z]+-[0-9]+)*[[:space:]]+${id}([^0-9]|$)`]).pipe(
    Effect.map((out) => out.split("\n").filter((l) => l.length > 0)),
    // git grep exits 1 when nothing matches.
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
  )
