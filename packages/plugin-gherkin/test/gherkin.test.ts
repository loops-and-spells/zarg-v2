import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { call, pricing, run } from "./harness"

describe("pricing example", () => {
  test("renders as Gherkin with shared states", async () => {
    const text = await run(Effect.andThen(pricing, PluginHost.use((h) => h.render(new Set(["UX-0003"])))))
    expect(text).toBe(
      [
        "UX-0003 Visitor picks Pro",
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
})

describe("gherkin rules", () => {
  test("an empty graph asks for the first requirement", async () => {
    const items = await run(PluginHost.use((h) => h.agenda()))
    expect(items.map((i) => i.id)).toEqual(["gherkin:empty"])
  })

  test("a state nothing leads to is unreached unless it is an entry", async () => {
    const ids = await run(
      Effect.andThen(call("add-state", { text: "a lonely screen", terminal: true }), PluginHost.use((h) => h.agenda())),
    )
    expect(ids.map((i) => i.id)).toEqual(["gherkin:unreached:S-0001"])
  })

  test("a card needs at least one Then", async () => {
    const err = await run(
      Effect.flip(call("add-card", { title: "t", when: "the user waits", arrives: { text: "a page is shown" }, then: [] })),
    )
    expect(err._tag).toBe("LintFailed")
    expect(err._tag === "LintFailed" && err.findings[0]?.code).toBe("too-few-edges")
  })

  test("more than five Thens is rejected", async () => {
    const then = [1, 2, 3, 4, 5, 6].map((i) => ({ text: `outcome number ${i} is shown` }))
    const err = await run(Effect.flip(call("add-card", { title: "t", when: "the user acts", arrives: { text: "start" }, then })))
    expect(err._tag === "LintFailed" && err.findings.map((f) => f.code)).toContain("too-many-edges")
  })

  test("a clause with 'if' is rejected", async () => {
    const err = await run(Effect.flip(call("add-state", { text: "the form is shown if the user is signed in" })))
    expect(err._tag === "LintFailed" && err.findings[0]?.code).toBe("conditional")
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

  test("unlink removes a then edge", async () => {
    const r = await run(Effect.andThen(pricing, call("unlink", { card: "UX-0004", edge: "then", state: "S-0005" })))
    expect(r.changed).toEqual(["UX-0004"])
  })
})
