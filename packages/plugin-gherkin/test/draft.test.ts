import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GraphStore } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { pricing, run } from "./harness"

const draft = [
  { tool: "add-state", params: { text: "the plan picker explains each plan" } },
  { tool: "add-card", params: { title: "Visitor reads a plan", when: "the visitor opens a plan's details", by: [{ id: "P-0001" }], arrives: { text: "the plan picker explains each plan" }, then: [{ text: "the plan's limits are listed" }] } },
  { tool: "edit-state", params: { id: "S-0002", text: "the plan picker is shown with prices" } },
]

describe("drafts", () => {
  test("a draft dry-runs in order (a card arriving from a state added before it); the graph is unchanged", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        const before = (yield* (yield* GraphStore).snapshot).nodes.size
        const r = (yield* h.invoke("gherkin", "dryRun", { draft })) as { ok: boolean; problems: string[]; touched: string[] }
        const after = (yield* (yield* GraphStore).snapshot).nodes.size
        return { r, before, after }
      }),
    )
    expect(out.r.ok).toBe(true)
    expect(out.r.problems).toEqual([])
    expect(out.r.touched).toEqual(expect.arrayContaining(["S-0002", "UX-0006"]))
    expect(out.after).toBe(out.before)
  })
  test("a draft that breaks a lint, or names no tool, comes back with its problems", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        return {
          lint: (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "edit-state", params: { id: "S-0002", text: "if the visitor wants, the picker is shown" } }] })) as { ok: boolean; problems: string[] },
          tool: (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "nope", params: {} }] })) as { ok: boolean; problems: string[] },
        }
      }),
    )
    expect(out.lint.ok).toBe(false)
    expect(out.lint.problems.join(" ")).toMatch(/if/)
    expect(out.tool.problems).toEqual(["nope is not a gherkin tool"])
  })
  test("steps and stories over a draft show the drafted cards; journeys list their cards", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        const step = (yield* h.invoke("gherkin", "step", { card: "UX-0001", draft })) as { thens: string[] }
        const plain = (yield* h.invoke("gherkin", "step", { card: "UX-0001" })) as { thens: string[] }
        const stories = (yield* h.invoke("gherkin", "stories", { strategy: "teleport", draft })) as { stories: string[][] }
        return { step, plain, stories, journeys: yield* h.invoke("gherkin", "journeys", {}) }
      }),
    )
    expect(out.step.thens).toEqual(["the plan picker is shown with prices"])
    expect(out.plain.thens).toEqual(["the plan picker is shown"])
    expect(out.stories.stories.flat()).toContain("UX-0006")
    expect(out.journeys).toEqual([])
  })
  test("the edge limits a write checks are checked after each call: a card's last then, a sixth then", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        const lastThen = (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "unlink", params: { card: "UX-0001", edge: "then", state: "S-0002" } }, { tool: "link", params: { card: "UX-0001", edge: "then", state: { text: "a new then" } } }] })) as { ok: boolean; problems: string[] }
        const six = (yield* h.invoke("gherkin", "dryRun", { draft: [1, 2, 3, 4, 5].map((i) => ({ tool: "link", params: { card: "UX-0001", edge: "then", state: { text: `then number ${i}` } } })) })) as { ok: boolean; problems: string[] }
        return { lastThen, six }
      }),
    )
    expect(out.lastThen.ok).toBe(false)
    expect(out.lastThen.problems.join(" ")).toMatch(/UX-0001.*then/)
    expect(out.six.ok).toBe(false)
    expect(out.six.problems.join(" ")).toMatch(/UX-0001.*then/)
  })
  test("a draft names the cards it affects: a reworded state's cards, a new card", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        return (yield* h.invoke("gherkin", "dryRun", { draft })) as { cards: string[] }
      }),
    )
    expect(out.cards).toEqual(["UX-0001", "UX-0002", "UX-0003", "UX-0006"])
  })
  test("compare: every card a draft touches (new ones too), as it is, as the draft leaves it, and as text, in one call", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        return (yield* h.invoke("gherkin", "compare", { draft, cards: ["UX-0001"] })) as { ok: boolean; cards: Array<{ id: string; before: { thens: string[] } | null; after: { title: string; given: string } | null; text: string }> }
      }),
    )
    expect(out.ok).toBe(true)
    const byId = Object.fromEntries(out.cards.map((c) => [c.id, c]))
    // Asked for, and touched by the reworded state.
    expect(byId["UX-0001"]?.before).not.toBeNull()
    // New: nothing before, the drafted card after.
    expect(byId["UX-0006"]?.before).toBeNull()
    expect(byId["UX-0006"]?.after?.title).toBe("Visitor reads a plan")
    expect(byId["UX-0001"]?.text).toContain("UX-0001")
  })
})
