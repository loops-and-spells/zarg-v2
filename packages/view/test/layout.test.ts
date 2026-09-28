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

test("an action on a reserved key, or two actions on one key, are refused; another platform's mapping is kept", () => {
  const table = (actions: ReadonlyArray<Record<string, unknown>>) => ({ t: { kind: "table" as const, role: "primary" as const, columns: [{ id: "c", label: "C" }], actions: actions as never } })
  expect(() => defineView("v", table([{ id: "a", label: "A", key: "tab", on: "row" }]))).toThrow(/tab, a key terminal keeps/)
  expect(() => defineView("v", table([{ id: "a", label: "A", keys: { terminal: "ctrl+a" }, on: "row" }]))).toThrow(/ctrl\+a/)
  expect(() => defineView("v", table([{ id: "a", label: "A", key: "/", on: "row" }]))).toThrow(/\//)
  expect(() => defineView("v", table([{ id: "a", label: "A", key: "r", on: "row" }]), { actions: [{ id: "b", label: "B", key: "r", on: "none" }] })).toThrow(/mapped twice/)
  expect(layoutOf(defineView("v", table([{ id: "a", label: "A", keys: { terminal: "a", web: "mod+enter" }, on: "row" }]))).sections[0]).toMatchObject({ actions: [{ keys: { terminal: "a", web: "mod+enter" } }] })
})

test("one key in two tables is fine: only the focused table answers it", () => {
  const table = { kind: "table" as const, columns: [{ id: "c", label: "C" }], actions: [{ id: "apply", label: "Apply", key: "a", on: "row" as const }] }
  expect(() => defineView("v", { review: { kind: "tabs", role: "pinned", tabs: { findings: table, likes: table } } })).not.toThrow()
})

test("keys.terminal wins over key, in the check as at run time: a reserved one hidden behind key is refused", () => {
  const t = { t: { kind: "table" as const, role: "primary" as const, columns: [], actions: [{ id: "a", label: "A", key: "z", keys: { terminal: "return" }, on: "row" as const }] } }
  expect(() => defineView("v", t)).toThrow(/return, a key terminal keeps/)
})

test("review marks tables only", () => {
  expect(() => defineView("v", { s: { kind: "log", role: "log", review: true } as never })).toThrow(/marks review but is a log/)
  expect(layoutOf(defineView("v", { t: { kind: "table", role: "primary", columns: [], review: true } })).sections[0]).toMatchObject({ review: true })
})
