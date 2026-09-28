import { defineView } from "@zarg/plugin-sdk"

/** Journeys, above the agents (the `journeys` nav item): every journey, and the highlighted one's cards as Gherkin. */
export const JourneysView = defineView("journeys", {
  // One line under the view's header: how many journeys, how many cards.
  summary: { kind: "stats", role: "summary" },
  // No heading of its own: the view's header already says Journeys.
  list: {
    kind: "table",
    role: "primary",
    title: "",
    // Sorting only: a journey is picked by moving to it.
    columns: [{ id: "name", label: "journey", filter: "none" }, { id: "cards", label: "cards", filter: "none" }],
    actions: [{ id: "open", label: "Refresh", key: "r", on: "none" }],
  },
  // The highlighted journey's cards as Gherkin.
  // No heading either: the flow's first line names the journey.
  flow: { kind: "text", role: "pinned", title: "", follows: "list" },
})
