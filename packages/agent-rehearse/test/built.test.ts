import { expect, test } from "bun:test"
import { cutStories } from "../src/built"

test("stories stop before a planned or untagged card; the run says why, once per card; a story left empty goes", () => {
  const built = (card: string) => (card === "C-3" ? ("planned" as const) : card === "C-5" ? ("untagged" as const) : ("built" as const))
  const out = cutStories([["C-1", "C-2", "C-3", "C-4"], ["C-5", "C-1"], ["C-2", "C-5"], ["C-1"]], built)
  expect(out.stories).toEqual([["C-1", "C-2"], ["C-2"], ["C-1"]])
  expect(out.notes).toEqual(["C-3: not built yet (planned): not walked", "C-5: no code tagged and not planned: tag its code or mark it planned"])
})
