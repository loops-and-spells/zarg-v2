import { describe, expect, test } from "bun:test"
import { boardCard, type Item, moved, neighbour, nextId, pickNext, stale } from "../src/items"

const item = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  title: `Plan ${id}`,
  journey: "Set up",
  cards: [{ ref: "gherkin/card:S-0062@3f9a1c20b7e4" }],
  changes: [],
  feedback: ["F-00000001", "F-00000002"],
  steps: [],
  status: "ready",
  events: [],
  persona: "Operator",
  severity: "medium",
  ...over,
})

describe("backlog items", () => {
  test("ids count up: B-01, then one past the highest", () => {
    expect(nextId([])).toBe("B-01")
    expect(nextId([item("B-01"), item("B-09")])).toBe("B-10")
  })
  test("a lane's neighbours; the ends stay put", () => {
    expect([neighbour("ready", 1), neighbour("ready", -1), neighbour("backlog", -1), neighbour("done", 1)]).toEqual(["running", "backlog", "backlog", "done"])
  })
  test("a move is recorded as an event, with who moved it", () => {
    expect(moved(item("B-01"), "running", "Planner", "applied in abc1234")).toMatchObject({ status: "running", agent: "Planner", events: [{ what: "ready → running: applied in abc1234", by: "Planner" }] })
  })
  test("next: the oldest Ready item whose after items are done and whose cards are unchanged", () => {
    const items = [item("B-03"), item("B-02", { after: ["B-01"] }), item("B-01", { status: "running" }), item("B-04", { cards: [{ ref: "gherkin/card:S-0001@000000000000" }] })]
    expect(pickNext(items, () => false)?.id).toBe("B-03")
    expect(pickNext(items.filter((i) => i.id !== "B-03"), (ref) => ref.includes("S-0001"))).toBeUndefined()
    expect(pickNext([item("B-01", { status: "done" }), item("B-04"), item("B-02", { after: ["B-01"] })], () => false)?.id).toBe("B-02")
  })
  test("a card on the board: stripe by severity, id and first card on top, feedback count, persona, and why it waits", () => {
    const all = [item("B-01", { status: "running", cards: [{ ref: "gherkin/card:S-0001@000000000000" }] })]
    expect(boardCard(item("B-02", { after: ["B-01"] }), all, new Set(["gherkin/card:S-0062@3f9a1c20b7e4"]))).toEqual({
      id: "B-02",
      title: "Plan B-02",
      tone: "severity.medium",
      top: "B-02 S-0062",
      badge: "◇2",
      lines: [{ text: "Operator", tone: "persona" }, { text: "⇠ after B-01", tone: "error" }, { text: "⚠ card changed", tone: "attention" }],
    })
    expect(boardCard(item("B-01", { status: "running", agent: "Planner" }), all, new Set()).lines).toEqual([{ text: "Operator", tone: "persona" }, { text: "⠼ Planner", tone: "accent" }])
  })
})

test("a plan after a missing plan is not held back; after a dropped one it is, and says so", () => {
  expect(pickNext([item("B-02", { after: ["B-09"] })], () => false)?.id).toBe("B-02")
  const all = [item("B-01", { dropped: true }), item("B-02", { after: ["B-01"] })]
  expect(pickNext(all, () => false)).toBeUndefined()
  expect(boardCard(all[1]!, all, new Set()).lines).toContainEqual({ text: "⇠ after B-01 (dropped)", tone: "error" })
})
test("a card a plan it waits on also touches is not changed for it: applying that plan changes it by design", () => {
  const changed = new Set(["gherkin/card:S-0062@3f9a1c20b7e4"])
  const all = [item("B-01", { status: "done" }), item("B-02", { after: ["B-01"] })]
  expect(pickNext(all, (r) => changed.has(r))?.id).toBe("B-02")
  expect(boardCard(all[1]!, all, changed).lines).not.toContainEqual({ text: "⚠ card changed", tone: "attention" })
  expect(stale(all[1]!, all, changed)).toEqual(new Set())
  expect(stale(item("B-03"), all, changed)).toEqual(changed)
})
