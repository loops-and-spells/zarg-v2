import { describe, expect, test } from "bun:test"
import { checkAppend, checkSet, defineView, layoutOf } from "../src"

const Tester = defineView("tester", {
  progress: { kind: "stats", role: "summary" },
  steps: { kind: "log", role: "log", title: "Steps" },
  review: {
    kind: "tabs",
    role: "pinned",
    tabs: {
      findings: { kind: "table", title: "Findings", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] },
      likes: { kind: "table", title: "Likes", columns: [{ id: "id", label: "id" }] },
    },
  },
})

describe("defineView", () => {
  test("a view becomes a layout: sections in declared order, tabs as nested leaves", () => {
    const l = layoutOf(Tester)
    expect(l.name).toBe("tester")
    expect(l.sections.map((s) => [s.id, s.kind, s.role])).toEqual([["progress", "stats", "summary"], ["steps", "log", "log"], ["review", "tabs", "pinned"]])
    const review = l.sections[2]!
    expect(review.kind === "tabs" && review.tabs.map((t) => t.id)).toEqual(["findings", "likes"])
  })

  test("a malformed view is refused where it is defined", () => {
    expect(() => defineView("Bad Name", { a: { kind: "log", role: "log" } })).toThrow(/view name/)
    expect(() => defineView("v", { "a.b": { kind: "log", role: "log" } })).toThrow(/section id/)
    expect(() => defineView("v", { t: { kind: "tabs", role: "pinned", tabs: {} } })).toThrow(/no tabs/)
    expect(() =>
      defineView("v", { t: { kind: "table", role: "primary", columns: [], actions: [{ id: "x", label: "X", on: "row" }, { id: "x", label: "Y", on: "row" }] } }),
    ).toThrow(/action x/)
  })

  test("typed paths and data: a wrong section or wrong data does not compile", () => {
    type Set = <P extends import("../src").SectionPath<typeof Tester.sections>>(p: P, d: import("../src").DataAt<typeof Tester.sections, P>) => void
    const set: Set = () => {}
    set("progress", { items: [] })
    set("review.findings", { rows: [] })
    // @ts-expect-error: no such section
    set("workers", { items: [] })
    // @ts-expect-error: a stats section takes items, not rows
    set("progress", { rows: [] })
    // @ts-expect-error: a tabs section has no data of its own
    set("review", { rows: [] })
    expect(true).toBe(true)
  })
})

describe("checking pushes against a layout", () => {
  const l = layoutOf(Tester)
  test("set accepts data of the section's kind and refuses the rest", () => {
    expect(checkSet(l, "review.findings", { rows: [{ id: "R-1", cells: { id: "R-1" } }] })).toMatchObject({ ok: true })
    expect(checkSet(l, "progress", { rows: [] })).toMatchObject({ ok: false, error: expect.stringContaining("progress") })
    expect(checkSet(l, "nope", { items: [] })).toMatchObject({ ok: false, error: expect.stringContaining("no section nope") })
    expect(checkSet(l, "review", { rows: [] })).toMatchObject({ ok: false })
  })
  test("append goes only to logs", () => {
    expect(checkAppend(l, "steps", [{ text: "x" }])).toMatchObject({ ok: true })
    expect(checkAppend(l, "progress", [{ text: "x" }])).toMatchObject({ ok: false, error: expect.stringContaining("not a log") })
  })
})
