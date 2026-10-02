// packages/core/test/rehearse-findings.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Complete } from "../src/types"
import { consolidate, diagnose, findingId, report } from "../src/findings"

const persona = { name: "developer", text: "The developer" }
const step = { scenario: "S-1", title: "Pay", given: "the payment form is shown", when: "the visitor pays", thens: ["the order is placed"], fork: [], hasFailure: false }
const replying = (text: string | Error): Complete => () => (text instanceof Error ? Effect.fail({ message: text.message }) : Effect.succeed({ text }))

describe("rehearse findings", () => {
  test("a flagged step yields typed findings, at most five", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ kind: "gap", severity: "medium", note: `n${i}` }))
    const out = await Effect.runPromise(diagnose(replying(JSON.stringify({ findings: six })), persona, [], step, ["fail"]))
    expect("findings" in out && out.findings.length).toBe(5)
    expect("findings" in out && out.findings[0]).toEqual({ kind: "gap", scenario: "S-1", severity: "medium", note: "n0" })
  })

  test("JSON in a fence or with words around it is read; JSON cut short is an infrastructure note, never raw JSON in a finding", async () => {
    const body = JSON.stringify({ findings: [{ kind: "gap", severity: "high", note: "no failure path" }] })
    for (const text of ["```json\n" + body + "\n```", `Here you go:\n${body}\nThat is all.`]) {
      expect(await Effect.runPromise(diagnose(replying(text), persona, [], step, ["fail"]))).toEqual({ findings: [{ kind: "gap", scenario: "S-1", severity: "high", note: "no failure path" }] })
    }
    expect(await Effect.runPromise(diagnose(replying('{\n  "f'), persona, [], step, ["fail"]))).toEqual({ infra: "S-1: the tester's answer was cut short" })
  })

  test("prose becomes one low friction; a model failure is an infrastructure note, never a finding", async () => {
    expect(await Effect.runPromise(diagnose(replying("I think it is fine"), persona, [], step, ["feel"]))).toEqual({
      findings: [{ kind: "friction", scenario: "S-1", severity: "low", note: "the tester answered in prose: I think it is fine" }],
    })
    expect(await Effect.runPromise(diagnose(replying(new Error("503")), persona, [], step, ["feel"]))).toEqual({ infra: "S-1: 503" })
  })

  test("findings on the same kind and place merge, keep the strongest severity, and keep a stable id", () => {
    const merged = consolidate([
      { persona: "a", kind: "gap", scenario: "S-1", severity: "low", note: "no error shown" },
      { persona: "b", kind: "gap", scenario: "S-1", severity: "high", note: "payment can fail silently" },
      { persona: "a", kind: "friction", scenario: "S-2", severity: "medium", note: "unclear" },
    ])
    expect(merged.map((f) => [f.id, f.kind, f.scenario, f.severity, f.count, f.personas])).toEqual([
      [findingId("gap", "S-1"), "gap", "S-1", "high", 2, ["a", "b"]],
      [findingId("friction", "S-2"), "friction", "S-2", "medium", 1, ["a"]],
    ])
    expect(findingId("gap", "S-1")).toMatch(/^R-[0-9a-f]{8}$/)
    expect(findingId("gap", "S-1")).toBe(findingId("gap", "S-1"))
  })

  test("the report is the model's text; a failed report says so", async () => {
    expect(await Effect.runPromise(report(replying("Testers stalled at payment."), [], { scenes: 3, flagged: 1, unscreened: 0 }))).toBe("Testers stalled at payment.")
    expect(await Effect.runPromise(report(replying(new Error("down")), [], { scenes: 3, flagged: 1, unscreened: 0 }))).toContain("report unavailable")
  })
})

test("a tester's note with a newline per word reads as one line", async () => {
  const text = JSON.stringify({ findings: [{ kind: "feature", severity: "medium", note: "I\n would\n want\n a  refresh." }] })
  expect(await Effect.runPromise(diagnose(replying(text), persona, [], step, ["fail"]))).toEqual({ findings: [{ kind: "feature", scenario: "S-1", severity: "medium", note: "I would want a refresh." }] })
})
