import { expect, test } from "bun:test"
import { cutStories } from "../src/built"

test("stories stop before a planned or untagged scenario; the run says why, once per scenario; a story left empty goes", () => {
  const built = (scenario: string) => (scenario === "S-3" ? ("planned" as const) : scenario === "S-5" ? ("untagged" as const) : ("built" as const))
  const out = cutStories([["S-1", "S-2", "S-3", "S-4"], ["S-5", "S-1"], ["S-2", "S-5"], ["S-1"]], built)
  expect(out.stories).toEqual([["S-1", "S-2"], ["S-2"], ["S-1"]])
  expect(out.notes).toEqual(["S-3: not built yet (planned): not walked", "S-5: no code tagged and not planned: tag its code or mark it planned"])
})
