import { afterAll, describe, expect, test } from "bun:test"
import { makeFindings } from "../src"
import { cleanup, repo } from "./repo"

afterAll(cleanup)

describe("findings", () => {
  test("raise, replace the same kind about the same cards, clear by card, survive a reopen", () => {
    const r = repo()
    const f = makeFindings(r)
    f.raise({ kind: "blocked-card", title: "C-1 contradicts C-2", detail: "d1", about: ["C-1", "C-2"], pass: "p1" })
    f.raise({ kind: "verify-failing", title: "verify fails", detail: "d", about: ["C-3"], pass: "p1" })
    f.raise({ kind: "blocked-card", title: "still", detail: "d2", about: ["C-2", "C-1"], pass: "p2" })
    expect(makeFindings(r).list().map((x) => [x.kind, x.detail])).toEqual([["verify-failing", "d"], ["blocked-card", "d2"]])
    expect(f.clearFor(["C-2"])).toBe(1)
    expect(f.list().map((x) => x.kind)).toEqual(["verify-failing"])
  })
})
