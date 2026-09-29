import { defineView } from "@zarg/plugin-sdk"

/** The Triage Agent's view: what it is on, the round's cards (each with its tries beside them), the journeys and what each waits for. */
export const TriageView = defineView("triage", {
  summary: { kind: "text", role: "summary", title: "" },
  cards: {
    kind: "table",
    role: "primary",
    title: "",
    columns: [
      { id: "g", label: "", filter: "none", tones: { "✓": "ok", "↻": "attention", "✗": "error", "⠹": "accent", "·": "dim" } },
      { id: "card", label: "card", ref: true, filter: "none" },
      { id: "time", label: "time", filter: "none" },
      { id: "think", label: "think", filter: "none", tone: "dim" },
      { id: "why", label: "why", filter: "none" },
    ],
    actions: [
      { id: "draft-again", label: "Draft again", key: "d", on: "row" },
      { id: "pause", label: "Pause", key: "p", on: "none" },
    ],
  },
  // The highlighted card's tries, and its change.
  detail: { kind: "text", role: "pinned", title: "", follows: "cards", beside: "cards" },
  journeys: {
    kind: "table",
    role: "pinned",
    title: "Journeys",
    columns: [
      { id: "g", label: "", filter: "none", tones: { "⠹": "accent", "◆": "attention", "✓": "ok", "·": "dim" } },
      { id: "journey", label: "journey", tone: "journey", filter: "none" },
      { id: "stage", label: "stage", filter: "none" },
      { id: "waits", label: "waits for", filter: "none" },
    ],
  },
})
