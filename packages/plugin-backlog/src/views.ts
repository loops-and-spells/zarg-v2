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
    // Each stage's step, as buttons (a button outside its stage says why it does nothing).
    actions: [
      { id: "refine", label: "Refine", key: "r", on: "none" },
      { id: "accept", label: "Accept", key: "a", on: "none" },
      { id: "skip", label: "Skip", key: "s", on: "none" },
      { id: "backlog", label: "Backlog plan", key: "b", on: "none" },
      { id: "plan-now", label: "Plan anyway", key: "n", on: "none" },
    ],
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
  // The stage's work: the proposal to decide, the re-rehearse, the drafted plan.
  work: { kind: "text", role: "aside", title: "" },
})

/** The Backlog (the `backlog` nav item): plans on a kanban the agents move; ⏎ opens one in the drawer. */
export const BacklogView = defineView("backlog", { board: { kind: "board", role: "primary", title: "" } })

/** The drawer (a sheet over the board): one plan in full, and where it can go next. */
export const ItemView = defineView(
  "item",
  { item: { kind: "text", role: "primary", title: "" } },
  {
    actions: [
      { id: "ready", label: "→ Ready", key: "r", on: "none" },
      { id: "park", label: "Park", key: "p", on: "none" },
      { id: "done", label: "Done", key: "d", on: "none" },
      { id: "drop", label: "Drop", key: "X", on: "none" },
    ],
  },
)
