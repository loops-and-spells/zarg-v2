import { describe, expect, test } from "bun:test"
import { makeChecker, manifest, toBody, topLevelNames } from "../src"
import { Notes } from "./fixtures"

describe("topLevelNames", () => {
  test("variables, destructuring, functions and classes at the top level only", () => {
    const cell = "const a = 1\nlet { b, c: [d] } = x\nfunction f() { const inner = 1 }\nclass K {}\nif (a) { const nested = 2 }"
    expect(topLevelNames(cell)).toEqual(["a", "b", "d", "f", "K"])
  })
})

describe("toBody", () => {
  test("strips types and persists top-level names in a finally", () => {
    const { body, names } = toBody("const n: number = 1\nreturn n")
    expect(names).toEqual(["n"])
    expect(body).not.toContain(": number")
    expect(body).toContain('finally {\ntry { globalThis["n"] = n } catch {}')
  })
})

describe("checker", () => {
  const checker = makeChecker(manifest([Notes]))
  test("a correct cell passes", () => {
    expect(checker.check('const r = yield* Notes.add({ text: "hi" })\nreturn r.id')).toEqual({ ok: true, errors: [] })
  })
  // @card UX-0048
  test("a service outside the manifest is an error on the cell's own line numbers", () => {
    const r = checker.check("const x = 1\nconst y = yield* Fs.read({ path: 'a' })")
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toBe("line 2: Cannot find name 'Fs'.")
  })
  test("wrong params are an error", () => {
    expect(checker.check("yield* Notes.add({ text: 1 })").errors[0]).toContain("line 1:")
  })
  test("names from earlier cells are known after declare, and forgotten after reset", () => {
    expect(checker.check("return earlier").ok).toBe(false)
    checker.declare(["earlier"])
    expect(checker.check("return earlier").ok).toBe(true)
    checker.reset()
    expect(checker.check("return earlier").ok).toBe(false)
  })
})

describe("toBody hoisting", () => {
  test("const, let and class become var so the finally can persist them", () => {
    const { body } = toBody("const a = 1\nlet b = 2\nclass K {}\nfunction f() { const inner = 3 }")
    expect(body).toContain("var a = 1")
    expect(body).toContain("var b = 2")
    expect(body).toContain("var K = class K")
    expect(body).toContain("const inner = 3")
  })
})
