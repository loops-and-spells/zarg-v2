import { expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph"
import { render } from "../src/render"

test("render shows a missing state instead of crashing", () => {
  const snap = Snapshot.make([
    { id: "S-0001", type: "gherkin/state", props: { text: "start" }, edges: [] },
    {
      id: "C-0001",
      type: "gherkin/card",
      props: { title: "Go", when: "the user goes" },
      edges: [
        { type: "gherkin/arrives", to: "S-0001" },
        { type: "gherkin/then", to: "S-0002" },
      ],
    },
  ])
  expect(render(snap)).toBe(
    ["C-0001 Go", "  Given start  # S-0001", "  When  the user goes", "  Then  <missing S-0002>  # S-0002"].join("\n"),
  )
})
