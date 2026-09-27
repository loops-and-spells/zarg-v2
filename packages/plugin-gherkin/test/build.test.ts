import { expect, test } from "bun:test"
import { join } from "node:path"

// `mise run zarg -- <cmd>` builds plugins first; the CLI's stdout must stay pure JSON for agents.
test("the plugin build writes nothing to stdout", () => {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../plugin/scripts/build-plugins.ts"), "plugin-gherkin"], { env: process.env })
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString()).toBe("")
  expect(p.stderr.toString()).toContain("plugin-gherkin:")
})
