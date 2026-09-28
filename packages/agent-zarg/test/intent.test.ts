import { expect, test } from "bun:test"
import { nextGoals } from "../src/intent"

const md = `---
status: accepted
next:
  - name: Providers and plugins in the app
    why: the operator sets up providers and plugins without editing files
  - name: Capture
    why: "the agent keeps the intent documents: the operator never edits them"
  - name: Code ownership
---
# Intent: zarg

Next:
1. **Prose**: a numbered list in the body is never read.
`

test("the intent's next goals, from its frontmatter, in order, with a short why and the whole goal as the task", () => {
  const goals = nextGoals(md, "intent/zarg.md")
  expect(goals.map((g) => g.label)).toEqual(["Providers and plugins in the app", "Capture", "Code ownership"])
  expect(goals[1]).toEqual({
    id: "intent/zarg.md#2",
    label: "Capture",
    why: "the agent keeps the intent documents: the operator never edits them",
    task: "Work on the next goal in intent/zarg.md: Capture: the agent keeps the intent documents: the operator never edits them.",
  })
  expect(goals[2]).toEqual({ id: "intent/zarg.md#3", label: "Code ownership", task: "Work on the next goal in intent/zarg.md: Code ownership." })
})

test("an intent without next goals, or with broken frontmatter, offers none", () => {
  expect(nextGoals("# Intent\n\n## Problem\n\nx\n", "intent/a.md")).toEqual([])
  expect(nextGoals("---\nnext: [\n", "intent/a.md")).toEqual([])
})
