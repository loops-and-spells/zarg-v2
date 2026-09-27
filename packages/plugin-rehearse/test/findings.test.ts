// packages/core/test/rehearse-findings.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Complete } from "../src/types"
import { consolidate, diagnose, findingId, report } from "../src/findings"

const persona = { name: "developer", text: "The developer" }
const step = { card: "UX-1", title: "Pay", given: "the payment form is shown", when: "the visitor pays", thens: ["the order is placed"], fork: [], hasFailure: false }
const replying = (text: string | Error): Complete => () => (text instanceof Error ? Effect.fail({ message: text.message }) : Effect.succeed({ text }))

describe("rehearse findings", () => {
  test("a flagged step yields typed findings, at most five", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ kind: "gap", severity: "medium", note: `n${i}` }))
    const out = await Effect.runPromise(diagnose(replying(JSON.stringify({ findings: six })), persona, [], step, ["fail"]))
    expect("findings" in out && out.findings.length).toBe(5)
    expect("findings" in out && out.findings[0]).toEqual({ kind: "gap", card: "UX-1", severity: "medium", note: "n0" })
  })

  test("prose becomes one low friction; a model failure is an infrastructure note, never a finding", async () => {
    expect(await Effect.runPromise(diagnose(replying("I think it is fine"), persona, [], step, ["feel"]))).toEqual({
      findings: [{ kind: "friction", card: "UX-1", severity: "low", note: "the tester answered in prose: I think it is fine" }],
    })
    expect(await Effect.runPromise(diagnose(replying(new Error("503")), persona, [], step, ["feel"]))).toEqual({ infra: "UX-1: 503" })
  })

  test("findings on the same kind and place merge, keep the strongest severity, and keep a stable id", () => {
    const merged = consolidate([
      { persona: "a", kind: "gap", card: "UX-1", severity: "low", note: "no error shown" },
      { persona: "b", kind: "gap", card: "UX-1", severity: "high", note: "payment can fail silently" },
      { persona: "a", kind: "friction", card: "UX-2", severity: "medium", note: "unclear" },
    ])
    expect(merged.map((f) => [f.id, f.kind, f.card, f.severity, f.count, f.personas])).toEqual([
      [findingId("gap", "UX-1"), "gap", "UX-1", "high", 2, ["a", "b"]],
      [findingId("friction", "UX-2"), "friction", "UX-2", "medium", 1, ["a"]],
    ])
    expect(findingId("gap", "UX-1")).toMatch(/^R-[0-9a-f]{8}$/)
    expect(findingId("gap", "UX-1")).toBe(findingId("gap", "UX-1"))
  })

  test("the report is the model's text; a failed report says so", async () => {
    expect(await Effect.runPromise(report(replying("Testers stalled at payment."), [], { steps: 3, flagged: 1, unscreened: 0 }))).toBe("Testers stalled at payment.")
    expect(await Effect.runPromise(report(replying(new Error("down")), [], { steps: 3, flagged: 1, unscreened: 0 }))).toContain("report unavailable")
  })
})
