import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("the client never imports core or any server module", () => {
  const src = join(import.meta.dir, "..", "src")
  const offenders = readdirSync(src).flatMap((f) =>
    [...readFileSync(join(src, f), "utf8").matchAll(/from\s+"([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((spec) => spec.startsWith("@zarg/core") || spec.includes("/server"))
      .map((spec) => `${f}: ${spec}`),
  )
  expect(offenders).toEqual([])
})
