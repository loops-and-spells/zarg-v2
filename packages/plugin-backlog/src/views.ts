import { defineView } from "@zarg/plugin-sdk"

/** Feedback (the `feedback` nav item): where a journey's feedback is triaged, then refined, re-rehearsed and planned. */
export const FeedbackView = defineView("feedback", {
  // The stepper for the selected journey, and how much of its feedback is on.
  stage: { kind: "text", role: "summary", title: "" },
  // Journeys with feedback; the highlighted one shows its feedback.
  journeys: {
    kind: "table",
    role: "primary",
    title: "",
    columns: [{ id: "journey", label: "journey", tone: "journey", filter: "none" }, { id: "open", label: "open", filter: "none" }, { id: "stage", label: "stage", filter: "values" }],
    actions: [{ id: "journey", label: "Show", on: "row", default: true, highlight: true }],
  },
  // The journey's open feedback: each on or off (the agent's first call, yours to flip).
  feedback: {
    kind: "table",
    role: "pinned",
    title: "",
    toggle: true,
    search: true,
    // What the journey's stage offers now (the view names them per stage); a note is always there.
    actions: [
      { id: "refine", label: "Refine", key: "r", on: "none" },
      { id: "note", label: "Note", key: "n", on: "row", input: "your note for refinement" },
    ],
    columns: [
      { id: "card", label: "card", ref: true, filter: "none" },
      { id: "severity", label: "severity", order: ["high", "medium", "low"], filter: "values", tones: { high: "severity.high", medium: "severity.medium", low: "severity.low" } },
      { id: "kind", label: "kind", filter: "values" },
      // ✎: the operator left a note for refinement (the detail shows it).
      { id: "note", label: "✎", filter: "none" },
      // Where an entry of a triage round stands (the others are blank: usable, for the next round).
      { id: "status", label: "status", filter: "values", tones: { queued: "dim", waiting: "dim", drafted: "ok", "left out": "error", "re-rehearsing": "accent", "still reported": "attention" } },
    ],
  },
  // The highlighted entry in full, and its card as the tester saw it.
  detail: { kind: "text", role: "pinned", title: "", follows: "feedback", beside: "feedback" },
  // The stage's work: the agent drafting, the re-rehearse, the drafted plan and its changes.
  work: { kind: "text", role: "aside", title: "" },
})

/** The Backlog (the `backlog` nav item): plans on a kanban the agents move; ⏎ opens one in the drawer. */
export const BacklogView = defineView("backlog", { board: { kind: "board", role: "primary", title: "" } })

/** The drawer (a sheet over the board): one plan in full, and where it can go next. */
export const ItemView = defineView(
  "item",
  // Plan: to read (what changes, card by card); For agents: every change, card version and feedback id.
  { item: { kind: "tabs", role: "primary", tabs: { plan: { kind: "text", title: "Plan" }, agent: { kind: "text", title: "For agents" } } } },
  {
    actions: [
      // Move to a lane (Ready: the Planner applies it); Drop; Resync, offered only while a card changed.
      { id: "move", label: "Move ▾", key: "m", on: "none", choices: [{ id: "backlog", label: "Backlog" }, { id: "ready", label: "Ready" }, { id: "running", label: "Running" }, { id: "review", label: "Review" }, { id: "done", label: "Done" }] },
      { id: "drop", label: "Drop", key: "X", on: "none" },
      { id: "resync", label: "Resync", key: "s", on: "none" },
    ],
  },
)
