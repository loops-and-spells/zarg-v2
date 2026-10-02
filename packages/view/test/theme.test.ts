import { expect, test } from "bun:test"
import { Schema } from "effect"
import { defineView, layoutOf, TableData, Tone, tonesProblem } from "../src"

test("a tone is a plugin key or an old tone name", () => {
  for (const t of ["warn", "normal", "scenario", "journey", "severity.high", "dim"]) expect(Schema.decodeUnknownExit(Tone)(t)._tag).toBe("Success")
  for (const t of ["ground", "running", "keyword", "nope"]) expect(Schema.decodeUnknownExit(Tone)(t)._tag).toBe("Failure")
})
test("tonesProblem refuses shell keys in a view's columns", () => {
  const ok = layoutOf(defineView("t", { list: { kind: "table", role: "primary", columns: [{ id: "c", label: "c", tone: "scenario", tones: { high: "severity.high" } }] } }))
  expect(tonesProblem([ok])).toBeUndefined()
  const bad = { ...ok, sections: [{ ...ok.sections[0]!, columns: [{ id: "c", label: "c", tone: "ground" }] }] } as never
  expect(tonesProblem([bad])).toMatch(/ground.*may name/)
})
test("a row with a shell key tone is refused", () => {
  expect(Schema.decodeUnknownExit(TableData)({ rows: [{ id: "a", cells: {}, tone: "running" }] })._tag).toBe("Failure")
})
