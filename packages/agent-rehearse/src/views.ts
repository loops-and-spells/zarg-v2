import { defineView } from "@zarg/plugin-sdk"

export const FINDING_COLUMNS = [
  { id: "id", label: "id" },
  { id: "kind", label: "kind" },
  { id: "card", label: "card" },
  { id: "severity", label: "severity" },
  { id: "suggested", label: "suggested" },
  { id: "note", label: "note" },
]
const ACTIONS = [
  { id: "apply", label: "Apply", key: "a", on: "selection" },
  { id: "dismiss", label: "Dismiss", key: "d", on: "selection" },
] as const
const review = {
  kind: "tabs",
  role: "pinned",
  tabs: {
    findings: { kind: "table", title: "Findings", columns: FINDING_COLUMNS, selectable: true, actions: ACTIONS },
    likes: { kind: "table", title: "Likes", columns: FINDING_COLUMNS, selectable: true, actions: ACTIONS },
  },
} as const
// A tester's findings join the review queue; the run's repeat every tester's, so they stay out of it.
const testerReview = { ...review, tabs: { ...review.tabs, findings: { ...review.tabs.findings, review: true } } } as const

/** One tester: its walk (workers), what it checked (steps), its findings. */
export const TesterView = defineView("tester", {
  progress: { kind: "stats", role: "summary" },
  workers: { kind: "list", role: "primary", title: "Workers" },
  steps: { kind: "log", role: "log", title: "Steps" },
  review: testerReview,
})

/** The whole run: progress over every tester, the report, every finding. */
export const RunView = defineView("run", {
  progress: { kind: "stats", role: "summary" },
  report: { kind: "text", role: "primary", title: "Report" },
  review,
})

/** The run in one line, in a status panel whatever is open. */
export const StatusView = defineView("status", { line: { kind: "stats", role: "summary" } })
