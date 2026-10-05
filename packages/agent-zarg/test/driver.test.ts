import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Bound } from "@zarg/kernel"
import { askFirst } from "../src/driver"

const writes: Bound = { def: { name: "Gherkin" } as never, handlers: { addScenario: () => Effect.succeed("created S-0001") } }

describe("ask before writing", () => {
  test("graph writes are refused until the developer adds the change shown to them in this item", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) })
    const gated = guard.gate(writes)!
    const refused = await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({})))
    expect(refused).toMatchObject({ _tag: "AskFirst" })
    expect((refused as { message: string }).message).toContain("Inquire.confirm")
    await Effect.runPromise(guard.asker.confirm!({ change: "Given a\nWhen b\nThen c" }))
    expect(await Effect.runPromise(gated.handlers.addScenario!({}))).toBe("created S-0001")
  })

  // @scenario S-0016
  test("an answer meets a newer edit: a node the change was shown about, changed since by another thread, refuses the save as stale", async () => {
    let version = "v1"
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) }, (ids) => Effect.succeed(Object.fromEntries(ids.map((id) => [id, version]))))
    const gated = guard.gate(writes)!
    await Effect.runPromise(guard.asker.confirm!({ change: "Edit ST-0002: the plan picker is shown with prices", about: ["ST-0002"] }))
    // Another thread rewords ST-0002 while the developer reads the change.
    version = "v2"
    const stale = await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({ id: "ST-0002", text: "x" })))
    expect(stale).toMatchObject({ _tag: "StaleNode" })
    expect((stale as { message: string }).message).toContain("ST-0002 changed since you showed the change")
    // Writes close: the change is shown again before anything is written.
    version = "v2"
    expect(await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({ id: "ST-0002", text: "x" })))).toMatchObject({ _tag: "AskFirst" })
  })

  // @scenario S-0009
  test("what is written is what the developer added: wording not in the change shown is refused", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) })
    const gated = guard.gate(writes)!
    await Effect.runPromise(guard.asker.confirm!({ change: "Add outcome to I-0001: Parents award points for finished chores." }))
    const drifted = await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({ intent: "I-0001", text: "Parents award points to family members for finished chores." })))
    expect(drifted).toMatchObject({ _tag: "NotShown" })
    expect((drifted as { message: string }).message).toContain("Parents award points to family members for finished chores.")
    // As shown (case and the closing period aside): written.
    expect(await Effect.runPromise(gated.handlers.addScenario!({ intent: "I-0001", text: "parents award points for finished chores" }))).toBe("created S-0001")
  })

  test("what the developer added is committed once written: at the next question, or when the item ends", async () => {
    const commits: Array<[ReadonlyArray<string>, string]> = []
    const ids: Bound = { def: { name: "Gherkin" } as never, handlers: { addScenario: () => Effect.succeed({ added: ["S-0003", "ST-0009"], changed: ["J-0001"], removed: [] }) } }
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) }, undefined, (i, m) => Effect.sync(() => void commits.push([i, m])))
    const gated = guard.gate(ids)!
    await Effect.runPromise(guard.asker.confirm!({ change: "Add scenario: Parent restricts a chore\nGiven a\nWhen b\nThen c" }))
    await Effect.runPromise(gated.handlers.addScenario!({}))
    expect(commits).toEqual([])
    await Effect.runPromise(guard.asker.ask({ question: "q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }))
    expect(commits).toEqual([[["S-0003", "ST-0009", "J-0001"], "req: S-0003, ST-0009, J-0001: Add scenario: Parent restricts a chore"]])
    await Effect.runPromise(guard.asker.confirm!({ change: "Edit ST-0009: the chore is shown" }))
    await Effect.runPromise(gated.handlers.addScenario!({}))
    await Effect.runPromise(guard.flush)
    expect(commits[1]).toEqual([["S-0003", "ST-0009", "J-0001"], "req: S-0003, ST-0009, J-0001: Edit ST-0009: the chore is shown"])
    // Nothing written since: nothing to commit.
    await Effect.runPromise(guard.flush)
    expect(commits.length).toBe(2)
  })

  test("Add with words of the operator's (a reason) is what to change, not a yes: nothing is written, and the words come back", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add", other: "drop 'or an unknown id'" }) })
    const gated = guard.gate(writes)!
    const a = await Effect.runPromise(guard.asker.confirm!({ change: "Given a\nWhen b or c\nThen d" }))
    expect(a).toEqual({ other: "drop 'or an unknown id'" })
    expect(await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({})))).toMatchObject({ _tag: "AskFirst" })
  })

  test("each driver item starts without an answer", async () => {
    const first = askFirst({ ask: () => Effect.succeed({ choice: "add" }) })
    await Effect.runPromise(first.asker.confirm!({ change: "Given a\nWhen b\nThen c" }))
    const next = askFirst({ ask: () => Effect.succeed({ choice: "add" }) })
    expect((await Effect.runPromise(Effect.flip(next.gate(writes)!.handlers.addScenario!({})))) as { _tag: string }).toMatchObject({ _tag: "AskFirst" })
  })

  test("a chat message about the question is not an answer; the driver choosing for the developer is", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ other: "why?", interjected: true, question: "inq-1" }), choose: (c) => Effect.succeed({ choice: c.choice }) })
    const gated = guard.gate(writes)!
    await Effect.runPromise(guard.asker.confirm!({ change: "Given a\nWhen b\nThen c" }))
    expect(await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({})))).toMatchObject({ _tag: "AskFirst" })
    await Effect.runPromise(guard.asker.choose!({ question: "inq-1", choice: "add", why: "they agreed" }))
    expect(await Effect.runPromise(gated.handlers.addScenario!({}))).toBe("created S-0001")
  })

  test("only the developer adding the exact change opens graph writes, and the next question closes them again", async () => {
    const answers = ["add", "a", "skip"]
    const guard = askFirst({ ask: () => Effect.succeed({ choice: answers.shift()! }) })
    const gated = guard.gate(writes)!
    const write = () => Effect.runPromise(Effect.flip(gated.handlers.addScenario!({})).pipe(Effect.orElseSucceed(() => "written" as const)))
    await Effect.runPromise(guard.asker.confirm!({ change: "Given the cart is full\nWhen the developer pays\nThen the order is placed" }))
    expect(await write()).toBe("written")
    await Effect.runPromise(guard.asker.ask({ question: "q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }))
    expect(await write()).toMatchObject({ _tag: "AskFirst" })
    await Effect.runPromise(guard.asker.confirm!({ change: "Given x\nWhen y\nThen z" }))
    expect(await write()).toMatchObject({ _tag: "AskFirst" })
  })

  test("the confirm question shows the change and offers add, skip, or typing what to change", async () => {
    const asked: Array<{ question: string; options: ReadonlyArray<{ id: string }>; allowOther?: boolean; otherLabel?: string }> = []
    const guard = askFirst({ ask: (q) => Effect.sync(() => (asked.push(q), { choice: "add" })) })
    await Effect.runPromise(guard.asker.confirm!({ change: "Given a\nWhen b\nThen c", about: ["ST-1"] }))
    expect(asked[0]!.question).toContain("Given a\nWhen b\nThen c")
    expect(asked[0]!.options.map((o) => o.id)).toEqual(["add", "skip"])
    // Changing it is typing what to change: the free-text row, labelled for it.
    expect(asked[0]).toMatchObject({ allowOther: true, otherLabel: "Change it" })
  })

  test("a discussed change the driver adds for the developer opens writes", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ other: "looks right", interjected: true, question: "inq-9" }), choose: (c) => Effect.succeed({ choice: c.choice }) })
    const gated = guard.gate(writes)!
    await Effect.runPromise(guard.asker.confirm!({ change: "Given a\nWhen b\nThen c" }))
    expect(await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({})))).toMatchObject({ _tag: "AskFirst" })
    await Effect.runPromise(guard.asker.choose!({ question: "inq-9", choice: "add", why: "they said it looks right" }))
    expect(await Effect.runPromise(gated.handlers.addScenario!({}))).toBe("created S-0001")
  })

  test("openFor opens writes for a finding until the next question; the gate remembers what the writes touched", async () => {
    const tracked: Bound = { def: { name: "Gherkin" } as never, handlers: { addScenario: () => Effect.succeed({ message: "ok", added: ["S-0009"], changed: ["ST-0001"], removed: [], warnings: [] }) } }
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "a" }) })
    const gated = guard.gate(tracked)!
    guard.openFor()
    await Effect.runPromise(gated.handlers.addScenario!({}))
    expect([...guard.touched()].sort()).toEqual(["S-0009", "ST-0001"])
    await Effect.runPromise(guard.asker.ask({ question: "q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }))
    expect(await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({})))).toMatchObject({ _tag: "AskFirst" })
  })
})
