import { afterAll, describe, expect, test } from "bun:test"
import { makeFindings } from "../src"
import { cleanup, repo } from "./repo"

afterAll(cleanup)

describe("findings", () => {
  test("raise, replace the same kind about the same cards, clear by card, survive a reopen", () => {
    const r = repo()
    const f = makeFindings(r)
    f.raise({ kind: "blocked-card", title: "UX-1 contradicts UX-2", detail: "d1", about: ["UX-1", "UX-2"], pass: "p1" })
    f.raise({ kind: "verify-failing", title: "verify fails", detail: "d", about: ["UX-3"], pass: "p1" })
    f.raise({ kind: "blocked-card", title: "still", detail: "d2", about: ["UX-2", "UX-1"], pass: "p2" })
    expect(makeFindings(r).list().map((x) => [x.kind, x.detail])).toEqual([["verify-failing", "d"], ["blocked-card", "d2"]])
    expect(f.clearFor(["UX-2"])).toBe(1)
    expect(f.list().map((x) => x.kind)).toEqual(["verify-failing"])
  })
})
