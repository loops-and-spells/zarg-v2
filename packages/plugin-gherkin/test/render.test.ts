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
