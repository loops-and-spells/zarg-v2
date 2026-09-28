import { Schema } from "effect"
import { pluginContract } from "@zarg/plugin-sdk"

/** Gherkin tool calls, in order: a change drafted over the graph, never written to it. */
export const Draft = Schema.Array(Schema.Struct({ tool: Schema.String, params: Schema.Unknown }))
export const StoriesParams = Schema.Struct({ strategy: Schema.Literals(["edge-pair", "teleport"]), focus: Schema.optionalKey(Schema.Array(Schema.String)), draft: Schema.optionalKey(Draft) })
export const StoriesResult = Schema.Struct({ stories: Schema.Array(Schema.Array(Schema.String)), unreachable: Schema.Number })
export const StepParams = Schema.Struct({ card: Schema.String, via: Schema.optionalKey(Schema.String), draft: Schema.optionalKey(Draft) })
export const StepView = Schema.NullOr(
  Schema.Struct({
    card: Schema.String,
    title: Schema.String,
    given: Schema.String,
    when: Schema.String,
    thens: Schema.Array(Schema.String),
    via: Schema.optionalKey(Schema.Struct({ card: Schema.String, when: Schema.String })),
    fork: Schema.Array(Schema.Struct({ card: Schema.String, when: Schema.String })),
    hasFailure: Schema.Boolean,
    // Optional for plugins built against an older contract.
    journeys: Schema.optionalKey(Schema.Array(Schema.String)),
    by: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
)

export const JourneyView = Schema.Struct({ id: Schema.String, name: Schema.String, cards: Schema.Array(Schema.String) })
export const DryRunParams = Schema.Struct({ draft: Draft })
/** A draft checked like a write: ok, or its problems (a tool's error, a lint); the nodes it would touch. */
export const DryRunResult = Schema.Struct({ ok: Schema.Boolean, problems: Schema.Array(Schema.String), touched: Schema.Array(Schema.String), messages: Schema.Array(Schema.String) })
export const PersonaView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["human", "cli", "agent"]),
  text: Schema.String,
  cards: Schema.Array(Schema.String),
})

/** Gherkin's read surface for other plugins: story planning, step views and personas for testers. */
export const Gherkin = pluginContract("gherkin", {
  stories: { params: StoriesParams, success: StoriesResult },
  step: { params: StepParams, success: StepView },
  personas: { params: Schema.Struct({}), success: Schema.Array(PersonaView) },
  journeys: { params: Schema.Struct({}), success: Schema.Array(JourneyView) },
  dryRun: { params: DryRunParams, success: DryRunResult },
})
