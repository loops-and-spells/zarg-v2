import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Tag, tags } from "@zarg/audit"

const MAX_LINES = 40
const MARK = "@" + "card"

/**
 * A card's code, for plugins (`Entities.code`): each `@card` tag's file and line, and the code after it (until the
 * next tag, at most 40 lines), redacted. One `git grep` serves every card for a few seconds.
 */
export const codeOf = (root: string, redact: (text: string) => string) => {
  let cached: { readonly at: number; readonly tags: ReadonlyArray<Tag> } | undefined
  const all = Effect.suspend(() =>
    cached !== undefined && Date.now() - cached.at < 5_000
      ? Effect.succeed(cached.tags)
      : Effect.map(tags(root), (t) => {
          cached = { at: Date.now(), tags: t }
          return t
        }),
  )
  return (card: string) =>
    Effect.map(all, (ts) =>
      ts
        .filter((t) => t.id === card)
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
