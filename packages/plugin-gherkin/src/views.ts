import { defineView } from "@zarg/plugin-sdk"

/** Journeys, above the agents (the `journeys` nav item): every journey, and the highlighted one's scenarios as Gherkin. */
export const JourneysView = defineView("journeys", {
  // One line under the view's header: how many journeys, how many scenarios.
  summary: { kind: "stats", role: "summary" },
  // No heading of its own: the view's header already says Journeys.
  list: {
    kind: "table",
    role: "primary",
    title: "",
    // Sorting only: a journey is picked by moving to it.
    columns: [{ id: "name", label: "journey", filter: "none" }, { id: "scenarios", label: "scenarios", filter: "none" }],
    actions: [{ id: "open", label: "Refresh", key: "r", on: "none" }],
  },
  // The highlighted journey's scenarios as Gherkin.
  // No heading either: the flow's first line names the journey.
  flow: { kind: "text", role: "pinned", title: "", follows: "list" },
})

/** Intents, above the agents (the `intents` nav item): every intent and its statements, with what serves them. */
export const IntentsView = defineView("intents", {
  summary: { kind: "stats", role: "summary" },
  list: {
    kind: "table",
    role: "primary",
    title: "",
    columns: [{ id: "item", label: "intent", filter: "search" }, { id: "cover", label: "served by", filter: "none" }],
    actions: [
      { id: "open", label: "Refresh", key: "r", on: "none" },
      { id: "add-outcome", label: "Outcome", key: "a", on: "row", input: "an outcome: one result for its users" },
      { id: "add-constraint", label: "Constraint", key: "k", on: "row", input: "a constraint: one rule that must hold" },
      { id: "ask-question", label: "Question", key: "q", on: "row", input: "an open question" },
      { id: "edit", label: "Edit", key: "e", on: "row", input: "the new wording" },
      { id: "answer", label: "Answer", on: "row", default: true, input: "the answer" },
      // d, not x: the terminal keeps x for itself.
      { id: "remove", label: "Remove", key: "d", on: "row", choices: [{ id: "yes", label: "Remove it" }, { id: "no", label: "Keep it" }] },
    ],
  },
  // The highlighted row in full: a statement with its journeys and their scenarios, beside the list.
  detail: { kind: "text", role: "pinned", title: "", follows: "list", beside: "list" },
})
