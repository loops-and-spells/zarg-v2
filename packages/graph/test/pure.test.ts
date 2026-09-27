import { describe, expect, test } from "bun:test"
import { join } from "node:path"

describe("@zarg/graph/pure", () => {
  test("bundles for a plugin with no Node built-ins", async () => {
    const out = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/pure.ts")], target: "browser", format: "cjs" })
    expect(out.success).toBe(true)
    const code = await out.outputs[0]!.text()
    expect(code).not.toMatch(/require\(["']node:|from ["']node:|require\(["']crypto["']\)/)
  })
  test("exports what plugins use", async () => {
    const pure = await import("../src/pure")
    const snap = pure.Snapshot.make([{ id: "S-0001", type: "gherkin/state", props: { text: "a" }, edges: [] }])
    expect(pure.Snapshot.get(snap, "S-0001")?.id).toBe("S-0001")
    expect(pure.diff(pure.Snapshot.empty, snap).added.map((n) => n.id)).toEqual(["S-0001"])
  })
})
