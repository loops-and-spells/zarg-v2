import { describe, expect, test } from "bun:test"
import { canonical, formatRef, parseRef, refProblem, versionOf } from "../src"

describe("refs", () => {
  test("parse and format round-trip, with and without a version", () => {
    for (const s of ["gherkin/scenario:S-0062", "gherkin/scenario:S-0062@3f9a1c20b7e4", "backlog/item:B-12"]) expect(formatRef(parseRef(s)!)).toBe(s)
    expect(parseRef("gherkin/scenario:S-0062@3f9a")).toEqual({ type: "gherkin/scenario", id: "S-0062", version: "3f9a" })
  })
  test("bad refs are refused with the reason", () => {
    expect(refProblem("S-0062")).toMatch(/type/)
    expect(refProblem("gherkin/scenario:")).toMatch(/id/)
    expect(refProblem("scenario:S-1")).toMatch(/plugin\/kind/)
    expect(refProblem("gherkin/scenario:a:b")).toMatch(/one ":"/)
    expect(refProblem("gherkin/scenario:S-1@")).toMatch(/version/)
    expect(parseRef("S-0062")).toBeUndefined()
  })
})
describe("versions", () => {
  test("canonical ignores key order; versionOf is 12 hex and stable", () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }))
    expect(versionOf({ a: 1 })).toMatch(/^[0-9a-f]{12}$/)
    expect(versionOf({ a: 1 })).toBe(versionOf({ a: 1 }))
    expect(versionOf({ a: 1 })).not.toBe(versionOf({ a: 2 }))
  })
})
