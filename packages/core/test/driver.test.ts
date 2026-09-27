import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Bound } from "@zarg/kernel"
import { askFirst } from "../src/driver"

const writes: Bound = { def: { name: "Gherkin" } as never, handlers: { addCard: () => Effect.succeed("created UX-0001") } }

describe("ask before writing", () => {
  test("graph writes are refused until the developer answered a question in this item", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "a" }) })
    const gated = guard.gate(writes)!
    const refused = await Effect.runPromise(Effect.flip(gated.handlers.addCard!({})))
    expect(refused).toMatchObject({ _tag: "AskFirst" })
    expect((refused as { message: string }).message).toContain("Inquire.ask")
    await Effect.runPromise(guard.asker.ask({ question: "Add the card?", options: [{ id: "a", label: "Yes" }, { id: "b", label: "No" }] }))
    expect(await Effect.runPromise(gated.handlers.addCard!({}))).toBe("created UX-0001")
  })

  test("each driver item starts without an answer", async () => {
    const first = askFirst({ ask: () => Effect.succeed({ choice: "a" }) })
    await Effect.runPromise(first.asker.ask({ question: "q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }))
    const next = askFirst({ ask: () => Effect.succeed({ choice: "a" }) })
    expect((await Effect.runPromise(Effect.flip(next.gate(writes)!.handlers.addCard!({})))) as { _tag: string }).toMatchObject({ _tag: "AskFirst" })
  })

  test("a chat message about the question is not an answer; the driver choosing for the developer is", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ other: "why?", interjected: true, question: "inq-1" }), choose: (c) => Effect.succeed({ choice: c.choice }) })
    const gated = guard.gate(writes)!
    await Effect.runPromise(guard.asker.ask({ question: "q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }))
    expect(await Effect.runPromise(Effect.flip(gated.handlers.addCard!({})))).toMatchObject({ _tag: "AskFirst" })
    await Effect.runPromise(guard.asker.choose!({ question: "inq-1", choice: "a", why: "they agreed" }))
    expect(await Effect.runPromise(gated.handlers.addCard!({}))).toBe("created UX-0001")
  })
})
