import { expect, test } from "bun:test"
import { nextGoals } from "../src/intent"

const md = `# Intent: zarg

## Current goals

Done:
- The feature graph.

Next:
1. **Plugins, continued**: providers become plugins, agents call plugin methods.
2. **Capture**: the driver becomes the intent agent and keeps \`intent/*.md\`.
3. **Rehearse**: roleplay testers over the graph (ported from Colony's flow tester).
4. **Specify**: intents projected to cards.
5. Implement code ownership (tagged regions).

## Open questions

- Rehearse cost and cadence.
`

test("the intent's next goals, in order, with a short why and the whole goal as the task", () => {
  const goals = nextGoals(md, "intent/zarg.md")
  expect(goals.map((g) => g.label)).toEqual(["Plugins, continued", "Capture", "Rehearse", "Specify", "Implement code ownership (tagged regions)"])
  expect(goals[2]).toEqual({
    id: "intent/zarg.md#3",
    label: "Rehearse",
    why: "roleplay testers over the graph (ported from Colony's flow tester)",
    task: "Work on the next goal in intent/zarg.md: Rehearse: roleplay testers over the graph (ported from Colony's flow tester).",
  })
})

test("an intent without next goals offers none", () => {
  expect(nextGoals("# Intent\n\n## Problem\n\nx\n", "intent/a.md")).toEqual([])
})
