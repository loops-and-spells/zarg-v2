import { expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { call, pricing, run } from "./harness"

test("a Gherkin render through the runtime stays within a few milliseconds", async () => {
  const ms = await run(Effect.gen(function* () {
    yield* pricing
    const host = yield* PluginHost
    yield* host.render() // warm: the process starts on first use
    const t = performance.now()
    for (let i = 0; i < 50; i++) yield* host.render()
    return (performance.now() - t) / 50
  }))
  console.log(`render via runtime: ${ms.toFixed(2)} ms per call`)
  expect(ms).toBeLessThan(5)
})
