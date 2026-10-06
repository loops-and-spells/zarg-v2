import { Effect, Schema } from "effect"
import { ConfigError } from "@zarg/model"

export const Budget = Schema.Struct({
  turns: Schema.Number,
  tokens: Schema.Number,
  wallMs: Schema.Number,
})
export type Budget = typeof Budget.Type

const Preset = Schema.Struct({
  layer: Schema.Array(Schema.String),
  spawns: Schema.optionalKey(Schema.Array(Schema.String)),
  /** false: never ask Decisions whether to split the task (the RLM can still spawn children itself). */
  atomize: Schema.optionalKey(Schema.Boolean),
  /** false: ask the model not to think before answering (faster; for light turns such as asking the operator). */
  reasoning: Schema.optionalKey(Schema.Boolean),
  role: Schema.String,
  budget: Schema.optionalKey(Schema.Struct({ turns: Schema.optionalKey(Schema.Number), tokens: Schema.optionalKey(Schema.Number), wallMs: Schema.optionalKey(Schema.Number) })),
  result: Schema.optionalKey(Schema.String),
  verify: Schema.optionalKey(Schema.Literals(["gate", "decision", "none"])),
  stance: Schema.optionalKey(Schema.String),
  /** By this turn a cell has written a file (Fs.write), or the agent is told to write now: implementers read whole budgets away. */
  writeBy: Schema.optionalKey(Schema.Number),
})
export type Preset = typeof Preset.Type

const RlmConfig = Schema.Struct({
  max_depth: Schema.optionalKey(Schema.Number),
  max_concurrent: Schema.optionalKey(Schema.Number),
  presets: Schema.optionalKey(Schema.Record(Schema.String, Preset)),
  atomize: Schema.optionalKey(Schema.Struct({ min_confidence: Schema.optionalKey(Schema.Number) })),
  extend: Schema.optionalKey(Schema.Struct({ turns: Schema.optionalKey(Schema.Number), max: Schema.optionalKey(Schema.Number) })),
})

export interface RlmSettings {
  readonly maxDepth: number
  readonly maxConcurrent: number
  /** `[rlm.atomize] min_confidence`: how sure a "no" must be to plan, and a "decision" check to pass. */
  readonly minConfidence: number
  readonly presets: Readonly<Record<string, Preset>>
  /** `[rlm.extend] turns`: turns granted when an agent at its budget is judged to be progressing. */
  readonly extendTurns: number
  /** `[rlm.extend] max`: extensions per agent; 0 turns them off. */
  readonly extendMax: number
}

// Tokens count each turn's whole prompt: 25 turns that keep up to KEEP_CHARS of reads (an implementer ran out at turn 18 of 25 on 400k).
export const DEFAULT_BUDGET: Budget = { turns: 25, tokens: 1_000_000, wallMs: 30 * 60_000 }

/** The presets from the spec; `[rlm.presets.*]` in config overrides them by name. */
export const DEFAULT_PRESETS: Readonly<Record<string, Preset>> = {
  // The driver asks the operator; it never splits its task, so atomize would only add a Decisions round trip.
  // Its Gherkin tools keep the intents from the conversation.
  // @scenario S-0102
  // Its turns are light (pick options, ask, reply), and thinking was ~80% of each turn's time.
  driver: { layer: ["Graph", "Entities:read", "Gherkin", "Inquire", "Fs:read", "Decisions", "Rehearse", "Rlm"], spawns: ["research"], atomize: false, reasoning: false, role: "driver", budget: { turns: 25 }, result: "text", verify: "none" },
  // Plan and implement phases (the reconcile loop): each runs per scenario in its own worktree.
  plan: { layer: ["Graph", "Entities:read", "Fs:read", "Decisions", "Rlm"], spawns: ["research"], role: "plan", budget: { turns: 30 }, result: "plan", verify: "none" },
  "implement-scenario": { layer: ["Graph", "Fs", "Sh", "Verify", "Rlm"], spawns: ["research"], role: "implement", budget: { turns: 25 }, result: "implement-scenario", verify: "gate", writeBy: 6 },
  fix: { layer: ["Graph", "Fs", "Sh", "Verify", "Rlm"], spawns: [], role: "implement", budget: { turns: 15 }, result: "text", verify: "none" },
  resolve: { layer: ["Fs", "Sh", "Rlm"], spawns: [], role: "implement", budget: { turns: 10 }, result: "resolve", verify: "none" },
  // A child a driver waits on: a question in it took 5 minutes of research at 15 turns.
  research: { layer: ["Graph", "Entities:read", "Fs:read", "Decisions", "Rlm"], spawns: ["research"], role: "driver", budget: { turns: 10 }, result: "research", verify: "none" },
}

/** `[rlm]` from config (already `${VAR}`-expanded), merged over the defaults. */
export const settings = (raw: unknown) =>
  Effect.gen(function* () {
    const cfg = yield* Schema.decodeUnknownEffect(RlmConfig)(raw ?? {}).pipe(
      Effect.mapError((e) => new ConfigError({ message: `[rlm]: ${e.message}`, key: "rlm" })),
    )
    const presets = { ...DEFAULT_PRESETS, ...cfg.presets }
    for (const [name, p] of Object.entries(presets)) {
      for (const child of p.spawns ?? []) {
        if (presets[child] === undefined) {
          return yield* new ConfigError({ message: `rlm.presets.${name}.spawns names unknown preset "${child}"`, key: `rlm.presets.${name}.spawns` })
        }
      }
    }
    return { maxDepth: cfg.max_depth ?? 4, maxConcurrent: cfg.max_concurrent ?? 8, minConfidence: cfg.atomize?.min_confidence ?? 0.5, presets, extendTurns: cfg.extend?.turns ?? 10, extendMax: cfg.extend?.max ?? 2 } satisfies RlmSettings
  })

export const budgetOf = (p: Preset, override: Partial<Budget> = {}): Budget => {
  const base = { ...DEFAULT_BUDGET, ...p.budget }
  // An override can only lower the preset's budget.
  return {
    turns: Math.min(base.turns, override.turns ?? Infinity),
    tokens: Math.min(base.tokens, override.tokens ?? Infinity),
    wallMs: Math.min(base.wallMs, override.wallMs ?? Infinity),
  }
}

/** Result Schemas by name; presets refer to them with `result = "<name>"`. */
export const RESULTS: Readonly<Record<string, Schema.Codec<any, any>>> = {
  text: Schema.String,
  research: Schema.Struct({ findings: Schema.Array(Schema.String), sources: Schema.Array(Schema.String) }),
  /** The plan's Markdown sections (Approach, Files, Tests, Depends on), or why the scenario cannot be planned. */
  plan: Schema.Struct({ plan: Schema.optionalKey(Schema.String), blocked: Schema.optionalKey(Schema.String) }),
  "implement-scenario": Schema.Struct({ files: Schema.Array(Schema.String), summary: Schema.String, blocked: Schema.optionalKey(Schema.String) }),
  resolve: Schema.Struct({ resolved: Schema.Boolean }),
}
