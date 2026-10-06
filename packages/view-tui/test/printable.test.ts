import { expect, test } from "bun:test"
import { printable } from "../src/markdown"

test("text the TUI draws loses escape sequences and control characters, keeping lines and tabs", () => {
  expect(printable("\x1b[31m✗\x1b[0m fail\n\tat x")).toBe("✗ fail\n\tat x")
  expect(printable("a\x1b]0;title\x07b\x1b]8;;http://x\x1b\\c")).toBe("abc")
  expect(printable("bell\x07 back\x08 del\x7f")).toBe("bell back del")
})
