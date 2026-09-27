import { expect, test } from "bun:test"
import { Effect } from "effect"
import { trustedAgents, ZARG_ROOT } from "../src/plugins"

test("zarg's own trusted agents are found in its packages and loaded by path", async () => {
  const agents = await Effect.runPromise(trustedAgents(ZARG_ROOT))
  expect(agents.map((a) => a.name)).toEqual(["zarg"])
})
