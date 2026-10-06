import { expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph"
import { render } from "../src/render"

test("render shows a missing state instead of crashing", () => {
  const snap = Snapshot.make([
    { id: "ST-0001", type: "gherkin/state", props: { text: "start" }, edges: [] },
    {
      id: "S-0001",
      type: "gherkin/scenario",
      props: { title: "Go", when: "the user goes" },
      edges: [
        { type: "gherkin/arrives", to: "ST-0001" },
        { type: "gherkin/then", to: "ST-0002" },
      ],
    },
  ])
  expect(render(snap)).toBe(
    ["S-0001 Go", "  Given start  # ST-0001", "  When  the user goes", "  Then  <missing ST-0002>  # ST-0002"].join("\n"),
  )
})

test("a graph with no scenarios says so, and names its intents, instead of rendering nothing", () => {
  const snap = Snapshot.make([
    { id: "I-0001", type: "gherkin/intent", props: { title: "A todo app for families", status: "accepted" }, edges: [{ type: "gherkin/has", to: "O-0001" }] },
    { id: "O-0001", type: "gherkin/outcome", props: { text: "Each member sees their chores" }, edges: [] },
  ])
  expect(render(snap)).toBe("No scenarios yet.\nIntents: I-0001 A todo app for families (render with its id in focus for its outcomes, constraints and questions)")
  expect(render(Snapshot.make([]))).toBe("No scenarios yet.")
})
