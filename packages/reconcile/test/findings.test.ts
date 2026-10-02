import { afterAll, describe, expect, test } from "bun:test"
import { makeFindings } from "../src"
import { cleanup, repo } from "./repo"

afterAll(cleanup)

describe("findings", () => {
  test("raise, replace the same kind about the same scenarios, clear by scenario, survive a reopen", () => {
    const r = repo()
    const f = makeFindings(r)
    f.raise({ kind: "blocked-scenario", title: "S-1 contradicts S-2", detail: "d1", about: ["S-1", "S-2"], pass: "p1" })
    f.raise({ kind: "verify-failing", title: "verify fails", detail: "d", about: ["S-3"], pass: "p1" })
    f.raise({ kind: "blocked-scenario", title: "still", detail: "d2", about: ["S-2", "S-1"], pass: "p2" })
    expect(makeFindings(r).list().map((x) => [x.kind, x.detail])).toEqual([["verify-failing", "d"], ["blocked-scenario", "d2"]])
    expect(f.clearFor(["S-2"])).toBe(1)
    expect(f.list().map((x) => x.kind)).toEqual(["verify-failing"])
  })
})
