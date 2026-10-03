import { expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { nextOutcomes } from "../src/intent"

test("what next: the outcomes no journey serves, in id order, each with its intent", () => {
  const snap = Snapshot.make([
    { id: "I-0001", type: "gherkin/intent", props: { title: "zarg", status: "accepted" }, edges: [{ type: "gherkin/has", to: "O-0002" }, { type: "gherkin/has", to: "O-0001" }, { type: "gherkin/has", to: "O-0003" }] },
    { id: "O-0001", type: "gherkin/outcome", props: { text: "One conversation" }, edges: [] },
    { id: "O-0002", type: "gherkin/outcome", props: { text: "The agent leads" }, edges: [] },
    { id: "O-0003", type: "gherkin/outcome", props: { text: "Served already" }, edges: [] },
    { id: "J-0001", type: "gherkin/journey", props: { name: "Talk" }, edges: [{ type: "gherkin/serves", to: "O-0003" }] },
  ] as never)
  expect(nextOutcomes(snap)).toEqual([
    { id: "O-0001", label: "One conversation", why: "zarg", task: 'Find or shape the journey that delivers O-0001 (One conversation), then link it with link {edge: "serves", journey, outcome: "O-0001"}.' },
    { id: "O-0002", label: "The agent leads", why: "zarg", task: 'Find or shape the journey that delivers O-0002 (The agent leads), then link it with link {edge: "serves", journey, outcome: "O-0002"}.' },
  ])
})
