import { expect, test } from "bun:test"
import { THEME, toneColor, toneToken } from "../src"

test("plugin tones map onto the theme; an unknown one draws as text", () => {
  expect(["normal", "ok", "warn", "error", "dim", "accent"].map(toneToken)).toEqual(["text", "ok", "attention", "error", "dim", "accent"])
  expect(toneToken(undefined)).toBe("text")
  expect(toneToken("purple")).toBe("text")
  expect(toneColor("warn")).toBe(THEME.attention)
})
