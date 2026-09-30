import { Effect } from "effect"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { join, sep } from "node:path"
import { deniedPath } from "../runtime/powers"
import { type Tag, tags } from "@zarg/audit"

const MAX_LINES = 40
const MARK = "@" + "card"

/**
 * A card's code, for plugins (`Entities.code`): each `@card` tag's file and line, and the code after it (until the
 * next tag, at most 40 lines), redacted. One `git grep` serves every card for a few seconds.
 */
export const codeOf = (root: string, redact: (text: string) => string, userDir = "\0no user dir") => {
  // One grep at a time: callers that come while it runs share it.
  let cached: { readonly at: number; readonly tags: Promise<ReadonlyArray<Tag>> } | undefined
  const all = Effect.suspend(() => {
    if (cached === undefined || Date.now() - cached.at >= 5_000) {
      const p = Effect.runPromise(tags(root))
      cached = { at: Date.now(), tags: p }
      p.catch(() => (cached = undefined))
    }
    const p = cached.tags
    return Effect.tryPromise({ try: () => p, catch: (e) => e })
  })
  const realRoot = realpathSync(root)
  // Never a file no plugin may read (secrets, config, git internals), never a link, never outside the project.
  const readable = (file: string) => {
    const path = join(root, file)
    try {
      if (lstatSync(path).isSymbolicLink()) return false
      const real = realpathSync(path)
      return real.startsWith(`${realRoot}${sep}`) && !deniedPath(real, userDir)
    } catch {
      return false
    }
  }
  return (card: string) =>
    Effect.map(all, (ts) =>
      ts
        .filter((t) => t.id === card && readable(t.file))
        .flatMap((t) => {
          let lines: Array<string>
          try {
            lines = readFileSync(join(root, t.file), "utf8").split("\n")
          } catch {
            return []
          }
          const after = lines.slice(t.line, t.line + MAX_LINES)
          const stop = after.findIndex((l) => l.includes(MARK))
          return [{ file: t.file, line: t.line, text: redact((stop >= 0 ? after.slice(0, stop) : after).join("\n")) }]
        }),
    )
}
