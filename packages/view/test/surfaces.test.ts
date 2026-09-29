import { expect, test } from "bun:test"
import { defineView, layoutOf, opensProblem, surfacesProblem } from "../src"

const runLayout = layoutOf(defineView("run", { line: { kind: "stats", role: "summary" } }))
const panel = { kind: "panel", name: "status", view: "run", scope: "shell", edge: "bottom", size: 1, input: "none" }
test("surfaces are checked: each kind's fields, a known view, a name once, a panel's size", () => {
  expect(surfacesProblem([panel, { kind: "tile", name: "main", view: "run" }], [runLayout])).toBeUndefined()
  expect(surfacesProblem(undefined, [runLayout])).toBeUndefined()
  expect(surfacesProblem([{ ...panel, edge: "left" }], [runLayout])).toMatch(/does not fit any kind/)
  expect(surfacesProblem([{ ...panel, view: "nope" }], [runLayout])).toMatch(/view nope, which the plugin does not declare/)
  expect(surfacesProblem([panel, panel], [runLayout])).toMatch(/declared twice/)
  expect(surfacesProblem([{ ...panel, size: 0 }], [runLayout])).toMatch(/size/)
  expect(surfacesProblem([{ ...panel, name: "Bad Name" }], [runLayout])).toMatch(/kebab-case/)
  expect(surfacesProblem("x", [runLayout])).toMatch(/list/)
})

test("an action's opens must name a declared surface", () => {
  const layout = { name: "run", sections: [{ id: "t", kind: "table", role: "primary", columns: [], actions: [{ id: "show", label: "Show", on: "none", opens: [{ surface: "main" }] }] }] }
  expect(opensProblem([layout as never], [{ name: "main" }])).toBeUndefined()
  expect(opensProblem([layout as never], [])).toMatch(/action show opens main, which the plugin does not declare/)
  expect(opensProblem([{ ...layout, sections: [], actions: [{ id: "v", label: "V", on: "none", opens: [{ surface: "x" }] }] } as never], [])).toMatch(/opens x/)
})

const tester = layoutOf(defineView("tester", { progress: { kind: "stats", role: "summary" }, steps: { kind: "log", role: "log" }, findings: { kind: "table", role: "primary", columns: [], actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] } }))
test("a card names a stats headline, a log/list/table recent and an action of its view", () => {
  const card = { kind: "card", name: "tester", view: "tester", headline: "progress", recent: "steps", action: "apply" }
  expect(surfacesProblem([card], [tester])).toBeUndefined()
  expect(surfacesProblem([{ ...card, headline: "steps" }], [tester])).toMatch(/headline steps is a log, not stats/)
  expect(surfacesProblem([{ ...card, recent: "progress" }], [tester])).toMatch(/recent progress is a stats/)
  expect(surfacesProblem([{ ...card, action: "nope" }], [tester])).toMatch(/action nope/)
  expect(surfacesProblem([{ ...card, view: "gone" }], [tester])).toMatch(/view gone/)
})

test("a nav item names a label and one of the plugin's views", () => {
  expect(surfacesProblem([{ kind: "nav", name: "journeys", view: "run", label: "Journeys" }], [runLayout])).toBeUndefined()
  expect(surfacesProblem([{ kind: "nav", name: "journeys", view: "run", label: "" }], [runLayout])).toMatch(/does not fit any kind/)
  expect(surfacesProblem([{ kind: "nav", name: "journeys", view: "nope", label: "Journeys" }], [runLayout])).toMatch(/view nope/)
})

test("a side panel is at most 40 wide; an overlay (a drawer over the tile) up to 120", () => {
  const p = (size: number, overlay?: boolean) => ({ kind: "panel" as const, name: "item", view: "run", scope: "agent" as const, edge: "right" as const, size, input: "onFocus" as const, ...(overlay !== undefined ? { overlay } : {}) })
  expect(surfacesProblem([p(41)], [runLayout])).toBe("panel item: size must be a whole number from 1 to 40")
  expect(surfacesProblem([p(90, true)], [runLayout])).toBeUndefined()
  expect(surfacesProblem([p(121, true)], [runLayout])).toBe("panel item: an overlay's size must be a whole number from 1 to 120")
})
