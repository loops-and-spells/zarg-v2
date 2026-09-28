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
  { id: "apply", label: "Send to zarg", key: "a", on: "selection" },
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
// The run's findings (every tester's, consolidated) join the review queue; a tester's own are the same ones, so they stay out.
const runReview = { ...review, tabs: { ...review.tabs, findings: { ...review.tabs.findings, review: true } } } as const

/** One tester: its walk (workers), what it checked (steps), its findings. */
export const TesterView = defineView("tester", {
  progress: { kind: "stats", role: "summary" },
  workers: { kind: "list", role: "primary", title: "Workers" },
  steps: { kind: "log", role: "log", title: "Steps" },
  review,
})

/** The whole run: progress over every tester, its testers, the report, every finding (sent to zarg from here). */
export const RunView = defineView("run", {
  progress: { kind: "stats", role: "summary" },
  testers: { kind: "list", role: "primary", title: "Testers" },
  report: { kind: "text", role: "aside", title: "Report" },
  review: runReview,
})

/** The run in one line, in a status panel whatever is open. */
export const StatusView = defineView("status", { line: { kind: "stats", role: "summary" } })
