import { defineView } from "@zarg/plugin-sdk"

/** Feedback (the `feedback` nav item): where a journey's feedback is triaged, then refined, re-rehearsed and planned. */
export const FeedbackView = defineView("feedback", {
  // The stepper for the selected journey, and how much of its feedback is on.
  stage: { kind: "text", role: "summary", title: "" },
  // Journeys with feedback; Enter shows one.
  journeys: {
    kind: "table",
    role: "primary",
    title: "",
    columns: [{ id: "journey", label: "journey", tone: "journey", filter: "none" }, { id: "open", label: "open", filter: "none" }, { id: "stage", label: "stage", filter: "values" }],
    actions: [{ id: "journey", label: "Show", on: "row", default: true }],
  },
  // The journey's open feedback: each on or off (the agent's first call, yours to flip).
  feedback: {
    kind: "table",
    role: "pinned",
    title: "",
    toggle: true,
    search: true,
    columns: [
      { id: "card", label: "card", ref: true, filter: "none" },
      { id: "severity", label: "severity", order: ["high", "medium", "low"], filter: "values", tones: { high: "severity.high", medium: "severity.medium", low: "severity.low" } },
      { id: "kind", label: "kind", filter: "values" },
      { id: "feedback", label: "feedback", filter: "none" },
      { id: "why", label: "why", filter: "none" },
    ],
  },
  // The highlighted entry in full, and its card as the tester saw it.
  detail: { kind: "text", role: "pinned", title: "", follows: "feedback", beside: "feedback" },
})
