import { defineView } from "@zarg/plugin-sdk"

const journeysTable = {
  kind: "table",
  role: "pinned",
  title: "Journeys",
  columns: [
    { id: "g", label: "", filter: "none", tones: { "●": "accent", "◆": "attention", "✓": "ok", "·": "dim" } },
    { id: "journey", label: "journey", tone: "journey", filter: "none" },
    { id: "stage", label: "stage", filter: "none" },
    { id: "waits", label: "", filter: "none" },
  ],
} as const

/** Triage (the parent agent): how many workers are busy, each worker, the journeys in line and what each waits for. */
export const RollupView = defineView("triage", {
  summary: { kind: "text", role: "summary", title: "" },
  workers: {
    kind: "table",
    role: "primary",
    title: "Workers",
    columns: [
      { id: "g", label: "", filter: "none", tones: { "⠋": "accent", "●": "accent", "·": "dim" } },
      { id: "worker", label: "worker", tone: "agent", filter: "none" },
      { id: "journey", label: "journey", tone: "journey", filter: "none" },
      { id: "now", label: "now", filter: "none" },
    ],
    actions: [{ id: "pause", label: "Pause", key: "p", on: "none" }],
  },
  journeys: journeysTable,
})

/** One triage worker: what it is on, its journey's scenarios (each scenario's tries and change beside the list). */
export const WorkerView = defineView("worker", {
  summary: { kind: "text", role: "summary", title: "" },
  scenarios: {
    kind: "table",
    role: "primary",
    title: "",
    columns: [
      { id: "g", label: "", filter: "none", tones: { "✓": "ok", "↻": "attention", "✗": "error", "⠋": "accent", "·": "dim" } },
      { id: "scenario", label: "scenario", ref: true, filter: "none" },
    ],
    actions: [{ id: "draft-again", label: "Draft again", key: "d", on: "row" }],
  },
  // The highlighted scenario's tries, and its change.
  detail: { kind: "text", role: "pinned", title: "", follows: "scenarios", beside: "scenarios" },
})
