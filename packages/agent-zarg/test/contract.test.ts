import { expect, test } from "bun:test"
import type { Effect } from "effect"
import type { Thread } from "@zarg/agent-host"
import zarg from "../src"
import type { makeThread } from "../src/thread"

// zarg's thread is the Thread the core serves: a compile-time check.
type Made = Effect.Success<ReturnType<typeof makeThread>>
const assignable: Thread = null as unknown as Made
void assignable

test("zarg is a trusted agent named zarg", () => {
  expect(zarg.name).toBe("zarg")
})
