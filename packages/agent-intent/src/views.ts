import { defineView } from "@zarg/plugin-sdk"

/** The Intent Agent: each statement or journey it reconciled, where its round ended, its plans. */
export const IntentView = defineView("intent", {
  summary: { kind: "text", role: "summary", title: "" },
  rounds: {
    kind: "table",
    role: "primary",
    title: "",
    columns: [
      { id: "id", label: "statement", ref: true, filter: "none" },
      { id: "state", label: "round", filter: "values", tones: { drafting: "accent", planned: "ok", asked: "attention", left: "error", nothing: "dim", waiting: "dim" } },
      { id: "plans", label: "plans", filter: "none" },
    ],
    actions: [{ id: "open", label: "Refresh", key: "r", on: "none" }],
  },
  detail: { kind: "text", role: "pinned", title: "", follows: "rounds", beside: "rounds" },
})
