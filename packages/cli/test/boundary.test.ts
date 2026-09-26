import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("the TUI never imports core or a server module", () => {
  const dir = join(import.meta.dir, "..", "src", "tui")
  const offenders = readdirSync(dir).flatMap((f) =>
    [...readFileSync(join(dir, f), "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((spec) => spec.startsWith("@zarg/core") || spec.includes("/server"))
      .map((spec) => `${f}: ${spec}`),
  )
  expect(offenders).toEqual([])
})
