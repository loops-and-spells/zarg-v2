import { describe, expect, test } from "bun:test"
import { planText } from "../src/plan-text"

const item = {
  id: "B-02", title: "Fix zarg journey feedback", journey: "Talk with zarg", persona: "Driver Agent", severity: "high" as const, status: "backlog" as const,
  cards: [{ ref: "gherkin/card:S-0071@aaaa1111" }, { ref: "gherkin/card:S-0011@bbbb2222" }],
  changes: [{ tool: "edit-card", params: {} }, { tool: "add-card", params: {} }, { tool: "link", params: {} }],
  feedback: ["F-1", "F-2", "F-3"], steps: ["Make S-0071 settle need confirmation.", "Split S-0011 typed answer from option pick."], events: [{ what: "planned", by: "Triage Agent" }],
}
const feedback = [
  { id: "F-1", kind: "gap", severity: "high", note: "No branch when the operator picks another option.", ref: "gherkin/card:S-0071@aaaa1111" },
  { id: "F-2", kind: "gap", severity: "medium", note: "Typing an answer and picking one are mixed.", ref: "gherkin/card:S-0011@bbbb2222" },
  { id: "F-3", kind: "friction", severity: "low", note: "Wordy.", ref: "gherkin/card:S-0011@bbbb2222" },
]
const cards = [
  {
    id: "S-0071", title: "Driver Agent chooses for the operator",
    before: ["Given the question stays open", "When  the conversation settles on one option", "Then  the chosen option is shown"],
    after: ["Given the question stays open", "When  the operator confirms one option", "Then  the chosen option is shown", "And   the saved answer carries option and reason"],
  },
  { id: "S-0090", title: "Operator types a custom answer", before: [], after: ["Given a question is shown", "When  the operator types their own answer", "Then  the answer is saved as typed"] },
]

describe("a plan for reading", () => {
  test("what it is, what it changes card by card (only the lines that change), what it closes", () => {
    const text = planText(item, feedback, cards, new Set())
    expect(text).toContain("B-02 · Backlog")
    expect(text).toContain("**Fix zarg journey feedback**")
    expect(text).toContain("Talk with zarg · Driver Agent · high")
    expect(text).toContain("2 cards: 1 changed, 1 new · 3 changes · closes 3 feedback (1 high)")
    expect(text).toContain("1. Make S-0071 settle need confirmation.")
    // A changed card: its title, then only what changes.
    expect(text).toContain("**S-0071** Driver Agent chooses for the operator")
    expect(text).toContain("- When  the conversation settles on one option")
    expect(text).toContain("+ When  the operator confirms one option")
    expect(text).toContain("+ And   the saved answer carries option and reason")
    expect(text).not.toContain("  Given the question stays open\n")
    // A new card, in full.
    expect(text).toContain("**New** Operator types a custom answer")
    expect(text).toContain("+ When  the operator types their own answer")
    // Feedback in numbers, the high ones in words.
    expect(text).toContain("gap 2 · friction 1")
    expect(text).toContain("◇ S-0071 No branch when the operator picks another option.")
    expect(text).not.toContain("Wordy.")
    expect(text).not.toContain('"tool"')
  })
  test("a card that changed since the plan was drafted is flagged, with how to resync", () => {
    expect(planText(item, feedback, cards, new Set(["gherkin/card:S-0071@aaaa1111"]))).toContain("⚠ S-0071 changed since this plan was drafted: **s** Resync")
  })
  test("cards with the same change (a reworded shared state) show once, their ids listed; changed-since warnings are one line", () => {
    const ripple = (id: string, title: string) => ({ id, title, before: ["Given the CLI actor works in a repo", "When  it asks", "Then  it is told"], after: ["Given one question is shown", "When  it asks", "Then  it is told"] })
    const text = planText(item, feedback, [...cards, ripple("S-0001", "CLI actor reads the agenda"), ripple("S-0002", "CLI actor adds a card"), ripple("S-0003", "A clause is refused")], new Set(["gherkin/card:S-0001@1111", "gherkin/card:S-0002@2222"]))
    expect(text).toContain("**S-0001, S-0002, S-0003** 3 cards, the same change")
    expect(text.match(/- Given the CLI actor works in a repo/g)?.length).toBe(1)
    expect(text).toContain("⚠ 2 cards changed since this plan was drafted (S-0001, S-0002): **s** Resync")
  })
})
