import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { call, pricing, run } from "./harness"

describe("pricing example", () => {
  // @card UX-0002
  test("renders as Gherkin with shared states", async () => {
    const text = await run(Effect.andThen(pricing, PluginHost.use((h) => h.render(new Set(["UX-0003"])))))
    expect(text).toBe(
      [
        "UX-0003 Visitor picks Pro",
        "  By    Visitor  # P-0001",
        "  Given the plan picker is shown  # S-0002",
        "  When  the visitor picks Pro",
        "  Then  the payment form is shown  # S-0004",
      ].join("\n"),
    )
  })

  test("state text given by value is reused, not duplicated", async () => {
    const text = await run(Effect.andThen(pricing, PluginHost.use((h) => h.render())))
    expect(text.match(/# S-0002/g)?.length).toBe(3)
    expect(text).not.toContain("S-0007")
  })

  // @card UX-0004
  test("rewording a state changes every card that uses it", async () => {
    const text = await run(
      Effect.gen(function* () {
        yield* pricing
        const r = yield* call("edit-state", { id: "S-0002", text: "the pricing plans are listed" })
        expect(r.changed).toEqual(["S-0002"])
        return yield* PluginHost.use((h) => h.render())
      }),
    )
    expect(text.match(/the pricing plans are listed/g)?.length).toBe(3)
    expect(text).not.toContain("plan picker")
  })

  test("agenda: receipt and decline message are dead ends until marked terminal", async () => {
    const ids = await run(
      Effect.gen(function* () {
        yield* pricing
        const before = (yield* PluginHost.use((h) => h.agenda())).map((i) => i.id)
        yield* call("edit-state", { id: "S-0005", terminal: true })
        const after = (yield* PluginHost.use((h) => h.agenda())).map((i) => i.id)
        return { before, after }
      }),
    )
    expect(ids.before).toEqual([
      "gherkin:dead-end:S-0003",
      "gherkin:dead-end:S-0005",
      "gherkin:dead-end:S-0006",
    ])
    expect(ids.after).toEqual(["gherkin:dead-end:S-0003", "gherkin:dead-end:S-0006"])
  })

  test("suggest: failure candidates for states with only one way on, busiest first, within focus", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("add-card", { title: "Visitor submits the account form", when: "the visitor submits the form", by: [{ id: "P-0001" }], arrives: { id: "S-0003" }, then: [{ text: "the account is created" }] })
        const all = yield* PluginHost.use((h) => h.suggest())
        const focused = yield* PluginHost.use((h) => h.suggest(new Set(["S-0001"])))
        yield* call("add-card", { title: "Visitor opens docs", when: 'the visitor clicks "Docs"', by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: "the docs are shown" }] })
        const branched = yield* PluginHost.use((h) => h.suggest())
        return { all, focused, branched }
      }),
    )
    expect(out.all.map((i) => i.id)).toEqual(["gherkin:one-way:S-0003", "gherkin:one-way:S-0001"])
    expect(out.all[0]).toMatchObject({
      title: 'A failure case for "Visitor submits the account form"',
      detail: "UX-0006 is the only way on from S-0003. Given the account form is shown. When the visitor submits the form. Then the account is created. Can it fail or go another way the user must handle?",
      about: ["S-0003", "UX-0006"],
    })
    expect(out.focused.map((i) => i.id)).toEqual(["gherkin:one-way:S-0001"])
    expect(out.branched.map((i) => i.id)).toEqual(["gherkin:one-way:S-0003"])
  })
})

describe("rehearse", () => {
  test("stories and steps come from the graph plugin", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const teleport = yield* PluginHost.use((h) => h.stories("teleport"))
        const edge = yield* PluginHost.use((h) => h.stories("edge-pair"))
        const first = teleport.stories[0]![0]!
        const step = yield* PluginHost.use((h) => h.step(first))
        const none = yield* PluginHost.use((h) => h.step("UX-9999"))
        return { teleport, edge, step, none }
      }),
    )
    expect(out.teleport.stories.length).toBeGreaterThan(0)
    expect(out.teleport.stories.every((s) => s.length === 1)).toBe(true)
    expect(out.edge.stories.length).toBeGreaterThan(0)
    expect(out.step).toMatchObject({ card: out.teleport.stories[0]![0], when: expect.any(String), thens: expect.any(Array) })
    expect(out.none).toBeUndefined()
  })
})

describe("gherkin rules", () => {
  test("an empty graph asks for the first requirement and who uses the product", async () => {
    const items = await run(PluginHost.use((h) => h.agenda()))
    expect(items.map((i) => i.id)).toEqual(["gherkin:empty", "gherkin:no-personas"])
  })

  test("a state nothing leads to is unreached unless it is an entry", async () => {
    const ids = await run(
      Effect.andThen(call("add-state", { text: "a lonely screen", terminal: true }), PluginHost.use((h) => h.agenda())),
    )
    expect(ids.map((i) => i.id)).toEqual(["gherkin:unreached:S-0001", "gherkin:no-personas"])
  })

  test("a card needs at least one Then", async () => {
    const err = await run(
      Effect.andThen(call("add-persona", { name: "User", kind: "human", text: "Someone using the product." }), Effect.flip(call("add-card", { title: "t", when: "the user waits", by: [{ name: "User" }], arrives: { text: "a page is shown" }, then: [] }))),
    )
    expect(err._tag).toBe("LintFailed")
    expect(err._tag === "LintFailed" && err.findings[0]?.code).toBe("too-few-edges")
  })

  test("more than five Thens is rejected", async () => {
    const then = [1, 2, 3, 4, 5, 6].map((i) => ({ text: `outcome number ${i} is shown` }))
    const err = await run(Effect.andThen(call("add-persona", { name: "User", kind: "human", text: "Someone using the product." }), Effect.flip(call("add-card", { title: "t", when: "the user acts", by: [{ name: "User" }], arrives: { text: "start" }, then }))))
    expect(err._tag === "LintFailed" && err.findings.map((f) => f.code)).toContain("too-many-edges")
  })

  // @card UX-0003
  test("a clause with 'if' is rejected", async () => {
    const err = await run(Effect.flip(call("add-state", { text: "the form is shown if the user is signed in" })))
    expect(err._tag === "LintFailed" && err.findings[0]?.code).toBe("conditional")
  })

  // @card UX-0006
  test("a refused change succeeds when retried using the hint", async () => {
    const out = await run(
      Effect.gen(function* () {
        const err = yield* Effect.flip(call("add-state", { text: "the form is shown if paid" }))
        const hint = err._tag === "LintFailed" ? err.findings[0]?.message : ""
        const ok = yield* call("add-state", { text: "the paid form is shown" })
        return { hint, added: ok.added }
      }),
    )
    expect(out.hint).toContain("make one card per case instead")
    expect(out.added).toEqual(["S-0001"])
  })

  test("a clause over 15 words is rejected", async () => {
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen"
    const err = await run(Effect.flip(call("add-state", { text: long })))
    expect(err._tag === "LintFailed" && err.findings[0]?.code).toBe("clause-too-long")
  })

  test("'and' is a warning only", async () => {
    const r = await run(call("add-state", { text: "the cart and the total are shown" }))
    expect(r.warnings.map((w) => w.code)).toEqual(["and-chaining"])
  })

  test("adding a state with existing text points at the existing one", async () => {
    const err = await run(
      Effect.andThen(call("add-state", { text: "the home page" }), Effect.flip(call("add-state", { text: "The home page." }))),
    )
    expect(err._tag === "ToolError" && err.message).toBe("S-0001 already has this text; use it")
  })

  test("near-duplicate state text warns", async () => {
    const r = await run(
      Effect.andThen(
        call("add-state", { text: "the payment form is shown now" }),
        call("add-state", { text: "the payment form is shown" }),
      ),
    )
    expect(r.warnings.map((w) => w.code)).toEqual(["near-duplicate-state"])
  })

  test("removing a used state is refused with the cards that use it", async () => {
    const err = await run(Effect.andThen(pricing, Effect.flip(call("remove", { id: "S-0004" }))))
    expect(err._tag === "ToolError" && err.message).toBe("S-0004 is used by UX-0003, UX-0004, UX-0005; relink or remove them first")
  })

  test("link arrives replaces the current arrival", async () => {
    const text = await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("link", { card: "UX-0003", edge: "arrives", state: { id: "S-0001" } })
        return yield* PluginHost.use((h) => h.render(new Set(["UX-0003"])))
      }),
    )
    expect(text).toContain("Given the visitor is on the home page  # S-0001")
    expect(text).not.toContain("S-0002")
  })

  // @card UX-0007
  test("add-card with the same Then twice is refused", async () => {
    const err = await run(
      Effect.andThen(
        pricing,
        Effect.flip(call("add-card", { title: "t", when: "the user acts", by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ id: "S-0002" }, { id: "S-0002" }] })),
      ),
    )
    expect(err._tag === "LintFailed" && err.findings.map((f) => f.code)).toContain("duplicate-edge")
  })

  test("unlink removes a then edge", async () => {
    const r = await run(Effect.andThen(pricing, call("unlink", { card: "UX-0004", edge: "then", state: "S-0005" })))
    expect(r.changed).toEqual(["UX-0004"])
  })
})
