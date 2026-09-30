import { expect, test } from "bun:test"
import { cutStories } from "../src/built"

test("stories stop before a planned or untagged card; the run says why, once per card; a story left empty goes", () => {
  const built = (card: string) => (card === "UX-3" ? ("planned" as const) : card === "UX-5" ? ("untagged" as const) : ("built" as const))
  const out = cutStories([["UX-1", "UX-2", "UX-3", "UX-4"], ["UX-5", "UX-1"], ["UX-2", "UX-5"], ["UX-1"]], built)
  expect(out.stories).toEqual([["UX-1", "UX-2"], ["UX-2"], ["UX-1"]])
  expect(out.notes).toEqual(["UX-3: not built yet (planned): not walked", "UX-5: no code tagged and not planned: tag its code or mark it planned"])
})
