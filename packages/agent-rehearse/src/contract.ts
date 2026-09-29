import { Schema } from "effect"
import { pluginContract } from "@zarg/plugin-sdk"

const Draft = Schema.Array(Schema.Struct({ tool: Schema.String, params: Schema.Unknown }))
export const RunParams = Schema.Struct({
  strategy: Schema.optionalKey(Schema.Literals(["journey", "edge-pair", "teleport"])).annotate({ description: "journey (default): every step and step pair inside each journey, plus the handoffs between journeys; edge-pair: the same over the whole graph; teleport: each card once, alone (quick)." }),
  focus: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Card or state ids: only stories through them." }),
  personas: Schema.optionalKey(Schema.Array(Schema.String)),
  draft: Schema.optionalKey(Draft).annotate({ description: "Gherkin tool calls to walk over instead of the graph as it is (never written)." }),
  file: Schema.optionalKey(Schema.Boolean).annotate({ description: "False: keep the findings for `result` instead of filing them with the backlog." }),
})
export const RunResult = Schema.Struct({ status: Schema.Literals(["running", "done", "stopped", "unknown"]), findings: Schema.Array(Schema.Struct({ card: Schema.String, kind: Schema.String, severity: Schema.Literals(["high", "medium", "low"]), note: Schema.String, on: Schema.Boolean })) })

/** Rehearse for other plugins (the Triage Agent): start a run (over a draft), read what it found. */
export const Rehearse = pluginContract("rehearse", {
  run: { params: RunParams, success: Schema.Unknown },
  result: { params: Schema.Struct({ run: Schema.String }), success: RunResult },
  /** Stop that run, when it is the one going (a triage round that left Re-rehearse). */
  stop: { params: Schema.Struct({ run: Schema.optionalKey(Schema.String) }), success: Schema.Null },
})
