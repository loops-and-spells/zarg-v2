import { expect, test } from "bun:test"
import { opensProblem, surfacesProblem } from "../src"

const panel = { kind: "panel", name: "status", view: "run", scope: "shell", edge: "bottom", size: 1, input: "none" }
test("surfaces are checked: each kind's fields, a known view, a name once, a panel's size", () => {
  expect(surfacesProblem([panel, { kind: "tile", name: "main", view: "run" }], ["run"])).toBeUndefined()
  expect(surfacesProblem(undefined, ["run"])).toBeUndefined()
  expect(surfacesProblem([{ ...panel, edge: "left" }], ["run"])).toMatch(/does not fit any kind/)
  expect(surfacesProblem([{ ...panel, view: "nope" }], ["run"])).toMatch(/view nope, which the plugin does not declare/)
  expect(surfacesProblem([panel, panel], ["run"])).toMatch(/declared twice/)
  expect(surfacesProblem([{ ...panel, size: 0 }], ["run"])).toMatch(/size/)
  expect(surfacesProblem([{ ...panel, name: "Bad Name" }], ["run"])).toMatch(/kebab-case/)
  expect(surfacesProblem("x", ["run"])).toMatch(/list/)
})

test("an action's opens must name a declared surface", () => {
  const layout = { name: "run", sections: [{ id: "t", kind: "table", role: "primary", columns: [], actions: [{ id: "show", label: "Show", on: "none", opens: [{ surface: "main" }] }] }] }
  expect(opensProblem([layout as never], [{ name: "main" }])).toBeUndefined()
  expect(opensProblem([layout as never], [])).toMatch(/action show opens main, which the plugin does not declare/)
  expect(opensProblem([{ ...layout, sections: [], actions: [{ id: "v", label: "V", on: "none", opens: [{ surface: "x" }] }] } as never], [])).toMatch(/opens x/)
})
