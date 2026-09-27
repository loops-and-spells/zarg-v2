import { expect, test } from "bun:test"
import type { Effect } from "effect"
import type { makeThread } from "@zarg/core"
import { defineTrustedAgent, type Thread } from "../src"

// The core's thread is the Thread every agent serves: a compile-time check.
type Made = Effect.Success<ReturnType<typeof makeThread>>
const assignable: Thread = null as unknown as Made
void assignable

test("a trusted agent is its own definition", () => {
  const a = defineTrustedAgent({ name: "x", start: () => null as never })
  expect(a.name).toBe("x")
})
