import { expect, test } from "bun:test"
import { trimOld } from "../src/rlm"

const tool = (n: number, size: number) => ({ role: "tool" as const, toolCallId: `c${n}`, content: `${n}`.padEnd(size, "x") })

test("older outputs stay whole while they fit the context budget; past it they are trimmed, the latest always whole", () => {
  const small = Array.from({ length: 10 }, (_, n) => tool(n, 5_000))
  trimOld(small as never, 4)
  expect(small.every((m) => !m.content.includes("[older output trimmed]"))).toBe(true)

  const big = Array.from({ length: 10 }, (_, n) => tool(n, 40_000))
  trimOld(big as never, 4)
  expect(big.map((m) => m.content.includes("[older output trimmed]"))).toEqual([true, true, true, true, true, true, false, false, false, false])
})
