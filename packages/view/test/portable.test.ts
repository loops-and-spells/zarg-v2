import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Web, native and terminal renderers all build on this package: it must not tie itself to one platform.
test("@zarg/view imports no platform module", () => {
  const dir = join(import.meta.dir, "..", "src")
  const offenders = readdirSync(dir).flatMap((f) =>
    [...readFileSync(join(dir, f), "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((spec) => spec === "react-dom" || spec.startsWith("react-dom/") || spec.startsWith("@opentui/") || spec === "react-native" || spec.startsWith("node:") || (f !== "react.ts" && spec === "react"))
      .map((spec) => `${f}: ${spec}`),
  )
  expect(offenders).toEqual([])
})
