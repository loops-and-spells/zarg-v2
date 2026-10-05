import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GraphStore } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { pricing, run } from "./harness"

const draft = [
  { tool: "add-state", params: { text: "the plan picker explains each plan" } },
  { tool: "add-scenario", params: { title: "Visitor reads a plan", when: "the visitor opens a plan's details", by: [{ id: "P-0001" }], arrives: { text: "the plan picker explains each plan" }, then: [{ text: "the plan's limits are listed" }] } },
  { tool: "edit-state", params: { id: "ST-0002", text: "the plan picker is shown with prices" } },
]

describe("drafts", () => {
  test("a draft dry-runs in order (a scenario arriving from a state added before it); the graph is unchanged", async () => {
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
    expect(out.r.touched).toEqual(expect.arrayContaining(["ST-0002", "S-0006"]))
    expect(out.after).toBe(out.before)
  })
  test("a draft that adds a state nothing uses is refused: drop it, or give it to a scenario", async () => {
    const r = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        return (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "add-state", params: { text: "the visitor closes the plan picker" } }] })) as { ok: boolean; problems: string[] }
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain("no scenario uses it")
    // Used by a scenario in the same draft: fine.
    const ok = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        return (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "add-state", params: { text: "the plan picker is gone" } }, { tool: "add-scenario", params: { title: "Visitor closes it", when: "the visitor closes the picker", by: [{ id: "P-0001" }], arrives: { id: "ST-0002" }, then: [{ text: "the plan picker is gone" }] } }] })) as { ok: boolean; problems: string[] }
      }),
    )
    expect(ok.problems).toEqual([])
  })
  test("a draft that puts what is already there touches nothing: a plan of it changes nothing", async () => {
    const r = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        const s = (yield* (yield* GraphStore).snapshot).nodes.get("ST-0002")!
        return (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "edit-state", params: { id: "ST-0002", text: String(s.props.text) } }] })) as { ok: boolean; touched: string[] }
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.touched).toEqual([])
  })
  // @scenario S-0103
  test("a dry run says the ids the next new nodes take (after the draft), so a draft can refer to what it adds", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        const now = (yield* h.invoke("gherkin", "dryRun", { draft: [] })) as { next: Record<string, string> }
        const after = (yield* h.invoke("gherkin", "dryRun", { draft })) as { next: Record<string, string> }
        return { now: now.next, after: after.next }
      }),
    )
    expect(out.now.scenario).toBe("S-0006")
    expect(out.after.scenario).toBe("S-0007")
    expect(Object.keys(out.now).sort()).toEqual(["journey", "persona", "scenario", "state"])
  })
  test("a draft that breaks a lint, or names no tool, comes back with its problems", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        return {
          lint: (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "edit-state", params: { id: "ST-0002", text: "if the visitor wants, the picker is shown" } }] })) as { ok: boolean; problems: string[] },
          tool: (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "nope", params: {} }] })) as { ok: boolean; problems: string[] },
          camel: (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "Gherkin.editState", params: { id: "ST-0002", text: "The picker is shown" } }] })) as { ok: boolean; problems: string[] },
          // The scenario a draft adds is linked by its title: its id is not known yet.
          byTitle: (yield* h.invoke("gherkin", "dryRun", {
            draft: [
              { tool: "addJourney", params: { name: "Picking" } },
              { tool: "addScenario", params: { title: "Visitor drops a plan", when: "the visitor drops a plan", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the plan is off the list" }] } },
              { tool: "link", params: { scenario: "visitor drops a plan", edge: "in", journey: "Picking" } },
            ],
          })) as { ok: boolean; problems: string[] },
          inJourney: (yield* h.invoke("gherkin", "dryRun", {
            draft: [
              { tool: "addJourney", params: { name: "Picking" } },
              { tool: "addScenario", params: { title: "Visitor drops a plan", when: "the visitor drops a plan", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the plan is off the list" }], in: ["Picking"] } },
            ],
          })) as { ok: boolean; problems: string[]; messages: string[] },
        }
      }),
    )
    expect(out.lint.ok).toBe(false)
    expect(out.lint.problems.join(" ")).toMatch(/if/)
    expect(out.tool.problems[0]).toStartWith("nope is not a gherkin tool (they are: ")
    expect(out.tool.problems[0]).toContain("add-scenario")
    expect(out.camel).toMatchObject({ ok: true, problems: [] })
    expect(out.byTitle).toMatchObject({ ok: true, problems: [] })
    expect(out.inJourney).toMatchObject({ ok: true, problems: [] })
  })
  test("scenes and stories over a draft show the drafted scenarios; journeys list their scenarios", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        const scene = (yield* h.invoke("gherkin", "scene", { scenario: "S-0001", draft })) as { thens: string[] }
        const plain = (yield* h.invoke("gherkin", "scene", { scenario: "S-0001" })) as { thens: string[] }
        const stories = (yield* h.invoke("gherkin", "stories", { strategy: "teleport", draft })) as { stories: string[][] }
        return { scene, plain, stories, journeys: yield* h.invoke("gherkin", "journeys", {}) }
      }),
    )
    expect(out.scene.thens).toEqual(["the plan picker is shown with prices"])
    expect(out.plain.thens).toEqual(["the plan picker is shown"])
    expect(out.stories.stories.flat()).toContain("S-0006")
    expect(out.journeys).toEqual([])
  })
  test("the edge limits a write checks are checked after each call: a scenario's last then, a sixth then", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        const lastThen = (yield* h.invoke("gherkin", "dryRun", { draft: [{ tool: "unlink", params: { scenario: "S-0001", edge: "then", state: "ST-0002" } }, { tool: "link", params: { scenario: "S-0001", edge: "then", state: { text: "a new then" } } }] })) as { ok: boolean; problems: string[] }
        const six = (yield* h.invoke("gherkin", "dryRun", { draft: [1, 2, 3, 4, 5].map((i) => ({ tool: "link", params: { scenario: "S-0001", edge: "then", state: { text: `then number ${i}` } } })) })) as { ok: boolean; problems: string[] }
        return { lastThen, six }
      }),
    )
    expect(out.lastThen.ok).toBe(false)
    expect(out.lastThen.problems.join(" ")).toMatch(/S-0001.*then/)
    expect(out.six.ok).toBe(false)
    expect(out.six.problems.join(" ")).toMatch(/S-0001.*then/)
  })
  test("a draft names the scenarios it affects: a reworded state's scenarios, a new scenario", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        return (yield* h.invoke("gherkin", "dryRun", { draft })) as { scenarios: string[] }
      }),
    )
    expect(out.scenarios).toEqual(["S-0001", "S-0002", "S-0003", "S-0006"])
  })
  test("compare: every scenario a draft touches (new ones too), as it is, as the draft leaves it, and as text, in one call", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        return (yield* h.invoke("gherkin", "compare", { draft, scenarios: ["S-0001"] })) as { ok: boolean; scenarios: Array<{ id: string; before: { thens: string[] } | null; after: { title: string; given: string } | null; text: string }> }
      }),
    )
    expect(out.ok).toBe(true)
    const byId = Object.fromEntries(out.scenarios.map((c) => [c.id, c]))
    // Asked for, and touched by the reworded state.
    expect(byId["S-0001"]?.before).not.toBeNull()
    // New: nothing before, the drafted scenario after.
    expect(byId["S-0006"]?.before).toBeNull()
    expect(byId["S-0006"]?.after?.title).toBe("Visitor reads a plan")
    expect(byId["S-0001"]?.text).toContain("S-0001")
  })
})
