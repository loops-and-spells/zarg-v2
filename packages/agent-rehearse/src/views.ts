import { defineView } from "@zarg/plugin-sdk"

// What a tester filed: the card (drawn as its label), where, what, and where the feedback is now (in Feedback).
export const FEEDBACK_COLUMNS = [
  { id: "card", label: "card", ref: true, filter: "none" },
  { id: "journey", label: "journey", filter: "values", tone: "journey" },
  { id: "kind", label: "kind", filter: "values" },
  { id: "severity", label: "severity", order: ["high", "medium", "low"], filter: "values", tones: { high: "severity.high", medium: "severity.medium", low: "severity.low" } },
  { id: "now", label: "now", filter: "values", tones: { open: "attention", off: "dim", stale: "dim", planned: "accent", closed: "ok" } },
] as const
const review = {
  kind: "tabs",
  role: "pinned",
  tabs: {
    feedback: { kind: "table", title: "Feedback", columns: FEEDBACK_COLUMNS, search: true },
    likes: { kind: "table", title: "Likes", columns: FEEDBACK_COLUMNS.filter((c) => c.id !== "now"), search: true },
  },
} as const

/** One tester: its walk (workers), what it checked (steps), what it filed (read-only: triage happens in Feedback). */
export const TesterView = defineView("tester", {
  progress: { kind: "stats", role: "summary" },
  workers: { kind: "list", role: "primary", title: "Workers" },
  steps: { kind: "log", role: "log", title: "Steps" },
  review,
  // The highlighted entry in full, beside the list.
  detail: { kind: "text", role: "pinned", title: "", follows: "review", beside: "review" },
})

/** The whole run, as a rollup: progress, its testers, feedback by journey, the report. Feedback is triaged in Feedback. */
export const RunView = defineView("run", {
  progress: { kind: "stats", role: "summary" },
  testers: { kind: "list", role: "primary", title: "Testers" },
  journeys: {
    kind: "table",
    role: "pinned",
    title: "Feedback by journey",
    columns: [
      { id: "journey", label: "journey", tone: "journey", filter: "none" },
      { id: "feedback", label: "feedback", filter: "none" },
      { id: "high", label: "high", tone: "severity.high", filter: "none" },
      { id: "medium", label: "medium", tone: "severity.medium", filter: "none" },
      { id: "low", label: "low", tone: "severity.low", filter: "none" },
    ],
  },
  report: { kind: "text", role: "aside", title: "Report" },
})

/** The run in one line, in a status panel whatever is open. */
export const StatusView = defineView("status", { line: { kind: "stats", role: "summary" } })
