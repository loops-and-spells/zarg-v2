import { afterAll, describe, expect, test } from "bun:test"
import { Cause, Data } from "effect"
import { makeFindings } from "../src"
import { causeText } from "../src/findings"
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
  test("a pass with nothing to do clears only that reconcile could not run; verify failing stays until a pass lands", () => {
    const r = repo()
    const f = makeFindings(r)
    f.raise({ kind: "pass-error", title: "reconcile cannot start", detail: "detached", about: [], pass: "" })
    f.raise({ kind: "verify-failing", title: "verify still fails after the fix attempts", detail: "exit 1", about: [], pass: "p1" })
    f.clearGeneral({ ran: true })
    expect(f.list().map((x) => x.kind)).toEqual(["verify-failing"])
    f.clearGeneral()
    expect(f.list()).toEqual([])
  })
  test("each raise and clear is heard, so the inbox shows a finding from a pass resumed after a restart", () => {
    let heard = 0
    const f = makeFindings(repo(), () => void heard++)
    f.raise({ kind: "verify-failing", title: "verify fails", detail: "d", about: [], pass: "p1" })
    f.clearGeneral({ ran: true })
    f.clearGeneral()
    expect(heard).toBe(2)
  })
  test("a failure reads as its message, never the Cause around it", () => {
    class RlmError extends Data.TaggedError("RlmError")<{ readonly message: string }> {}
    expect(causeText(Cause.fail(new RlmError({ message: "plan did not finish within its budget (20 turns)" })))).toBe("plan did not finish within its budget (20 turns)")
    expect(causeText(Cause.die("boom"))).toBe("boom")
  })
})
