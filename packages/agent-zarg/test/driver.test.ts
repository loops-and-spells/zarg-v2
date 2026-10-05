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

  test("a change the operator added before a restart opens writes for it at once: its wording only", async () => {
    const guard = askFirst({ ask: () => Effect.die("never asked"), approved: () => "Add outcome to I-0001: A reader sees what is left" })
    const gated = guard.gate(writes)!
    expect(await Effect.runPromise(gated.handlers.addScenario!({ intent: "I-0001", text: "A reader sees what is left" }))).toBe("created S-0001")
    expect(await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({ intent: "I-0001", text: "Something else entirely" })))).toMatchObject({ _tag: "NotShown" })
  })

  // @scenario S-0017
  test("a newer edit to another part of the node merges: the write goes through, their edit stays, and the merge is noted", async () => {
    let node = { props: { name: "Parent", text: "a parent who assigns chores." }, edges: [] as ReadonlyArray<{ type: string; to: string }> }
    const notes: Array<string> = []
    const editPersona: Bound = { def: { name: "Gherkin" } as never, handlers: { editPersona: (p) => Effect.sync(() => ((node = { ...node, props: { ...node.props, name: (p as { name: string }).name } }), { added: [], changed: ["P-0001"], removed: [] })) } }
    const guard = askFirst(
      { ask: () => Effect.succeed({ choice: "add" }), note: (t) => Effect.sync(() => void notes.push(t)) },
      (ids) => Effect.succeed(Object.fromEntries(ids.map((id) => [id, JSON.stringify(node)]))),
      undefined,
      (ids) => Effect.succeed(Object.fromEntries(ids.map((id) => [id, node]))),
    )
    await Effect.runPromise(guard.asker.confirm!({ change: "Rename persona Parent to Guardian", about: ["P-0001"] }))
    // Another thread rewords its text meanwhile.
    node = { ...node, props: { ...node.props, text: "a parent who sets the chores." } }
    expect(await Effect.runPromise(guard.gate(editPersona)!.handlers.editPersona!({ id: "P-0001", name: "Guardian" }))).toMatchObject({ changed: ["P-0001"] })
    expect(node.props).toEqual({ name: "Guardian", text: "a parent who sets the chores." })
    expect(notes[0]).toContain("Merged with another edit to P-0001")
  })

  // @scenario S-0018
  test("a newer edit to the same part conflicts: refused, with both versions and the merge question to ask", async () => {
    let node = { props: { text: "a parent who assigns chores." }, edges: [] as ReadonlyArray<{ type: string; to: string }> }
    const guard = askFirst(
      { ask: () => Effect.succeed({ choice: "add" }) },
      (ids) => Effect.succeed(Object.fromEntries(ids.map((id) => [id, JSON.stringify(node)]))),
      undefined,
      (ids) => Effect.succeed(Object.fromEntries(ids.map((id) => [id, node]))),
    )
    await Effect.runPromise(guard.asker.confirm!({ change: "Edit persona Parent: a parent who assigns and checks chores.", about: ["P-0001"] }))
    node = { ...node, props: { text: "a parent who sets the chores." } }
    const refused = (await Effect.runPromise(Effect.flip(guard.gate(writes)!.handlers.addScenario!({ id: "P-0001", text: "a parent who assigns and checks chores." })))) as { _tag: string; message: string }
    expect(refused._tag).toBe("StaleNode")
    expect(refused.message).toContain('text: "a parent who sets the chores."')
    expect(refused.message).toContain("Inquire.ask")
  })

  // @scenario S-0016
  test("a change's own writes are never a newer edit: writing it in parts changes the node it was shown about, and the next part still saves", async () => {
    let version = "v1"
    const parts: Bound = { def: { name: "Gherkin" } as never, handlers: { addOutcome: () => Effect.sync(() => ((version = `v${Number(version.slice(1)) + 1}`), { added: ["O-1"], changed: ["I-0001"], removed: [] })) } }
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) }, (ids) => Effect.succeed(Object.fromEntries(ids.map((id) => [id, version]))))
    const gated = guard.gate(parts)!
    await Effect.runPromise(guard.asker.confirm!({ change: "Add outcomes to I-0001: a reader adds a book; a reader marks a book read", about: ["I-0001"] }))
    await Effect.runPromise(gated.handlers.addOutcome!({ intent: "I-0001", text: "a reader adds a book" }))
    expect(await Effect.runPromise(gated.handlers.addOutcome!({ intent: "I-0001", text: "a reader marks a book read" }))).toMatchObject({ changed: ["I-0001"] })
  })

  // @scenario S-0016
  test("a node the change adds is never a newer edit: shown about before it existed, the change's next part still saves", async () => {
    const nodes: Record<string, string | undefined> = {}
    const parts: Bound = {
      def: { name: "Gherkin" } as never,
      handlers: {
        addScenario: () => Effect.sync(() => ((nodes["S-0004"] = "v1"), { added: ["S-0004"], changed: [], removed: [] })),
        link: () => Effect.sync(() => ((nodes["S-0004"] = "v2"), { added: [], changed: ["S-0004"], removed: [] })),
      },
    }
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) }, (ids) => Effect.succeed(Object.fromEntries(ids.map((id) => [id, nodes[id]]))))
    const gated = guard.gate(parts)!
    await Effect.runPromise(guard.asker.confirm!({ change: "Scenario S-0004 Reader removes a book, in journey J-0001", about: ["S-0004"] }))
    await Effect.runPromise(gated.handlers.addScenario!({ title: "Reader removes a book" }))
    expect(await Effect.runPromise(gated.handlers.link!({ scenario: "S-0004", journey: { id: "J-0001" } }))).toMatchObject({ changed: ["S-0004"] })
  })

  // @scenario S-0009 S-0019
  test("an option that is a change adds it when picked: the question shows its exact change, and writes open for that wording only", async () => {
    let shown = ""
    const guard = askFirst({ ask: (q) => Effect.sync(() => ((shown = q.question), { choice: "terminal" })) })
    const gated = guard.gate(writes)!
    await Effect.runPromise(
      guard.asker.ask({
        question: "Root a scenario from it, or mark it terminal?",
        options: [
          { id: "root", label: "Root a scenario" },
          { id: "terminal", label: "Mark it terminal", change: "Make the state ST-0005 \"What is left\" terminal" },
        ],
      }),
    )
    expect(shown).toContain("Mark it terminal: Make the state ST-0005 \"What is left\" terminal")
    expect(await Effect.runPromise(gated.handlers.addScenario!({ id: "ST-0005", text: "What is left" }))).toBe("created S-0001")
    expect(await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({ text: "Something else" })))).toMatchObject({ _tag: "NotShown" })
  })

  test("a picked option's change is never asked again: the answer says to write it, and confirming that same change answers add at once", async () => {
    let asked = 0
    const guard = askFirst({ ask: () => Effect.sync(() => (asked++, { choice: "terminal" })) })
    const a = await Effect.runPromise(guard.asker.ask({ question: "Which?", options: [{ id: "root", label: "Root" }, { id: "terminal", label: "Terminal", change: "Make ST-0005 terminal." }] }))
    expect(a.hint).toContain("Write it now")
    expect(await Effect.runPromise(guard.asker.confirm!({ change: "make ST-0005 terminal" }))).toEqual({ choice: "add" })
    expect(asked).toBe(1)
    expect(await Effect.runPromise(guard.gate(writes)!.handlers.addScenario!({ id: "ST-0005" }))).toBe("created S-0001")
  })

  test("an option whose change is blank is no change: nothing added to the question, nothing opened", async () => {
    let shown = ""
    const guard = askFirst({ ask: (q) => Effect.sync(() => ((shown = q.question), { choice: "a" })) })
    await Effect.runPromise(guard.asker.ask({ question: "How?", options: [{ id: "a", label: "Journey", change: " " }, { id: "b", label: "Teleport" }] }))
    expect(shown).toBe("How?")
    expect(await Effect.runPromise(Effect.flip(guard.gate(writes)!.handlers.addScenario!({})))).toMatchObject({ _tag: "AskFirst" })
  })

  test("an option with a change not picked opens nothing", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "root" }) })
    const gated = guard.gate(writes)!
    await Effect.runPromise(guard.asker.ask({ question: "Which?", options: [{ id: "root", label: "Root" }, { id: "terminal", label: "Terminal", change: "Make ST-0005 terminal" }] }))
    expect(await Effect.runPromise(Effect.flip(gated.handlers.addScenario!({})))).toMatchObject({ _tag: "AskFirst" })
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

  test("wording shown in quotes, sentence by sentence, is the same wording: quote marks and line breaks aside", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) })
    const gated = guard.gate(writes)!
    await Effect.runPromise(guard.asker.confirm!({ change: 'Add persona Child (human): "A child in the family tracker." "They see the chores assigned to them."' }))
    expect(await Effect.runPromise(gated.handlers.addScenario!({ name: "Child", text: "A child in the family tracker.\nThey see the chores assigned to them." }))).toBe("created S-0001")
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

  test("a long first line is cut at a word, with an ellipsis: a commit subject never ends mid-word", async () => {
    const commits: Array<string> = []
    const ids: Bound = { def: { name: "Gherkin" } as never, handlers: { addScenario: () => Effect.succeed({ added: ["P-0001"], changed: [], removed: [] }) } }
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) }, undefined, (_, m) => Effect.sync(() => void commits.push(m)))
    const change = 'Add persona "Shelf reader" (human): "A person tending a shelf for books to read, as in README.md."'
    await Effect.runPromise(guard.asker.confirm!({ change }))
    await Effect.runPromise(guard.gate(ids)!.handlers.addScenario!({}))
    await Effect.runPromise(guard.flush)
    expect(commits[0]).toBe('req: P-0001: Add persona "Shelf reader" (human): "A person tending a shelf for books…')
  })

  test("a first line that only heads the change (it ends with a colon) takes the next line into the subject", async () => {
    const commits: Array<string> = []
    const ids: Bound = { def: { name: "Gherkin" } as never, handlers: { addScenario: () => Effect.succeed({ added: ["I-0001"], changed: [], removed: [] }) } }
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) }, undefined, (_, m) => Effect.sync(() => void commits.push(m)))
    await Effect.runPromise(guard.asker.confirm!({ change: "Intent:\nTally: a tiny habit tally.\nOutcomes:\n1. A user marks a habit done today." }))
    await Effect.runPromise(guard.gate(ids)!.handlers.addScenario!({}))
    await Effect.runPromise(guard.flush)
    expect(commits[0]).toBe("req: I-0001: Intent: Tally: a tiny habit tally.")
  })

  test("a change shown with its draft is dry-run first: one the checks refuse goes back to the driver, never to the operator", async () => {
    let asked = 0
    const guard = askFirst({ ask: () => Effect.sync(() => (asked++, { choice: "add" })) }, undefined, undefined, undefined, (draft) =>
      Effect.succeed(JSON.stringify(draft).includes("removes a book") ? { ok: false, problems: ['S-0004: its Then "a reader removes a book" says its When again'] } : { ok: true, problems: [] }),
    )
    const bad = await Effect.runPromise(guard.asker.confirm!({ change: "Scenario: Reader removes a book", draft: [{ tool: "add-scenario", params: { then: [{ text: "a reader removes a book" }] } }] }))
    expect(asked).toBe(0)
    expect(bad).toMatchObject({ problems: ['S-0004: its Then "a reader removes a book" says its When again'] })
    const good = await Effect.runPromise(guard.asker.confirm!({ change: "Scenario: Reader removes a book", draft: [{ tool: "add-scenario", params: { then: [{ text: "the book is gone" }] } }] }))
    expect(asked).toBe(1)
    expect(good).toEqual({ choice: "add" })
  })

  test("a scenario change shown without its draft goes back for it: the checks need the tool calls", async () => {
    let asked = 0
    const guard = askFirst({ ask: () => Effect.sync(() => (asked++, { choice: "add" })) }, undefined, undefined, undefined, () => Effect.succeed({ ok: true, problems: [] }))
    const back = await Effect.runPromise(guard.asker.confirm!({ change: "S-0003 Tracker renames a habit\n  By Tracker\n  When Tracker renames the habit\n  Then the habit has its new name" }))
    expect(asked).toBe(0)
    expect(back.problems?.[0]).toContain("draft")
    // A change with no scenario in it (a persona's text) needs none.
    expect(await Effect.runPromise(guard.asker.confirm!({ change: "Edit persona Tracker: a person who tracks habits." }))).toEqual({ choice: "add" })
  })

  test("a change added but not written yet is owed: the item that ends there hands it on", async () => {
    const guard = askFirst({ ask: () => Effect.succeed({ choice: "add" }) })
    expect(guard.owed()).toBeUndefined()
    await Effect.runPromise(guard.asker.confirm!({ change: "Journey: Agent chat memory lifecycle" }))
    expect(guard.owed()).toBe("Journey: Agent chat memory lifecycle")
    await Effect.runPromise(guard.gate(writes)!.handlers.addScenario!({ name: "Agent chat memory lifecycle" }))
    expect(guard.owed()).toBeUndefined()
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
