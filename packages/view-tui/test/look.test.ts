import { expect, test } from "bun:test"
import { fit, gauge, heading, keyGlyphs } from "../src/look"

test("`fit` cuts at the end and never wraps", () => {
  expect(fit("tester-1", 12)).toBe("tester-1")
  expect(fit("a very long agent title that goes on", 12)).toBe("a very long…")
  expect(fit("line one\nline two", 40)).toBe("line one line two")
  expect(fit("x", 0)).toBe("")
})
test("a heading is its title and a faint rule to the width", () => {
  expect(heading("findings 3", 20)).toEqual({ title: "findings 3", rule: " ─────────" })
  expect(heading("a title far too long for it", 10).title).toBe("a title f…")
})
test("a gauge splits its cells into done and rest", () => {
  expect(gauge(12, 18, 6)).toEqual({ done: "━━━━", rest: "━━" })
  expect(gauge(0, 0, 4)).toEqual({ done: "", rest: "━━━━" })
})
test("`keyGlyphs` keeps keys it has no glyph for", () => {
  expect(keyGlyphs("Enter")).toBe("⏎")
  expect(keyGlyphs("Esc")).toBe("esc")
  expect(keyGlyphs("Tab")).toBe("⇥")
  expect(keyGlyphs("Space")).toBe("␣")
  expect(keyGlyphs("PgUp PgDn")).toBe("PgUp PgDn")
  expect(keyGlyphs("X")).toBe("X")
})
