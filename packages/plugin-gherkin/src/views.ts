import { defineView } from "@zarg/plugin-sdk"

/** Journeys, above the agents (the `journeys` nav item): every journey, and the chosen one's cards as Gherkin. */
export const JourneysView = defineView("journeys", {
  list: {
    kind: "table",
    role: "primary",
    title: "Journeys",
    columns: [{ id: "name", label: "journey" }, { id: "cards", label: "cards" }],
    actions: [
      { id: "show", label: "Show", key: "s", on: "row", default: true },
      { id: "open", label: "Refresh", key: "r", on: "none" },
    ],
  },
  flow: { kind: "text", role: "pinned", title: "Flow" },
})
