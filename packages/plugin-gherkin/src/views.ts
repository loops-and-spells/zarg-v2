import { defineView } from "@zarg/plugin-sdk"

/** Journeys, above the agents (the `journeys` nav item): every journey, and the highlighted one's cards as Gherkin. */
export const JourneysView = defineView("journeys", {
  list: {
    kind: "table",
    role: "primary",
    title: "Journeys",
    // Sorting only: a journey is picked by moving to it.
    columns: [{ id: "name", label: "journey", filter: "none" }, { id: "cards", label: "cards", filter: "none" }],
    actions: [{ id: "open", label: "Refresh", key: "r", on: "none" }],
  },
  // The highlighted journey's cards as Gherkin.
  flow: { kind: "text", role: "pinned", title: "Flow", follows: "list" },
})
