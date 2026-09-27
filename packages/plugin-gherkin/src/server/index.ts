import { server } from "@zarg/plugin/server"
import { agenda, suggest } from "./agenda"
import { clauseShape, stateText } from "./lints"
import { CardProps, StateProps } from "./model"
import { render } from "./render"
import { tools } from "./tools"

export const gherkin = server({
  name: "gherkin",
  nodes: { state: StateProps, card: CardProps },
  edges: {
    arrives: { from: "card", to: "state", min: 1, max: 1 },
    given: { from: "card", to: "state", max: 3 },
    then: { from: "card", to: "state", min: 1, max: 5 },
  },
  lints: [clauseShape, stateText],
  tools,
  agenda,
  suggest,
  render,
})

export * from "./affected"
export * from "./model"
