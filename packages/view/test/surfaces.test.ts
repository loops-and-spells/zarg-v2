import { expect, test } from "bun:test"
import { surfacesProblem } from "../src"

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
