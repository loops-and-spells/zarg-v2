import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeGrants, scopesDigest } from "../src/runtime"

const dir = () => mkdtempSync(join(tmpdir(), "zt-grants-"))

describe("grants", () => {
  test("a load approval is per project, plugin and scopes digest", async () => {
    const file = join(dir(), "grants.json")
    const d1 = scopesDigest({ net: ["a.test"] }, {})
    const d2 = scopesDigest({ net: ["a.test", "b.test"] }, {})
    // Adding a dependency asks again: through it the plugin reaches another plugin's data.
    expect(scopesDigest({ net: ["a.test"] }, {}, ["gherkin"])).not.toBe(d1)
    expect(scopesDigest({ net: ["a.test"] }, {}, [])).toBe(d1)
    const r = await Effect.runPromise(Effect.gen(function* () {
      const g = yield* makeGrants({ file, project: "/p/one" })
      yield* g.approveLoad("tracker", d1)
      const other = yield* makeGrants({ file, project: "/p/two" })
      return { same: (yield* g.of("tracker", d1)).loaded, newScopes: (yield* g.of("tracker", d2)).loaded, otherProject: (yield* other.of("tracker", d1)).loaded }
    }))
    expect(r).toEqual({ same: true, newScopes: false, otherProject: false })
    expect(JSON.parse(readFileSync(file, "utf8"))).toBeTruthy()
  })
  test("grants you start are kept, and survive a new digest", async () => {
    const file = join(dir(), "grants.json")
    const r = await Effect.runPromise(Effect.gen(function* () {
      const g = yield* makeGrants({ file, project: "/p" })
      yield* g.add("tracker", { kind: "fs-read", glob: "/mnt/data/**" })
      return (yield* g.of("tracker", "any-digest")).extra
    }))
    expect(r).toEqual([{ kind: "fs-read", glob: "/mnt/data/**" }])
  })
})
