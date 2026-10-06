import { expect, test } from "bun:test"
import { headline } from "../src/driver"

test("a change's headline (its commit subject) skips a lead-in to the operator", () => {
  expect(headline("As you said: the next story is the worker's.\nAdd a persona: extraction worker.")).toBe("Add a persona: extraction worker.")
  expect(headline("Add a scenario starting from it:\nCLI coding agent searches")).toBe("Add a scenario starting from it: CLI coding agent searches")
})
