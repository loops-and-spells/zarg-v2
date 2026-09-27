import { expect, test } from "bun:test"
import { defineTrustedAgent } from "../src"

test("a trusted agent is its own definition", () => {
  const a = defineTrustedAgent({ name: "x", start: () => null as never })
  expect(a.name).toBe("x")
})
