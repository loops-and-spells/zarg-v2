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
  /** false: ask the model not to think before answering (faster; for light turns such as asking the developer). */
  reasoning: Schema.optionalKey(Schema.Boolean),
  role: Schema.String,
  budget: Schema.optionalKey(Schema.Struct({ turns: Schema.optionalKey(Schema.Number), tokens: Schema.optionalKey(Schema.Number), wallMs: Schema.optionalKey(Schema.Number) })),
  result: Schema.optionalKey(Schema.String),
  verify: Schema.optionalKey(Schema.Literals(["gate", "decision", "none"])),
  stance: Schema.optionalKey(Schema.String),
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

export const DEFAULT_BUDGET: Budget = { turns: 25, tokens: 400_000, wallMs: 30 * 60_000 }

/** The presets from the spec; `[rlm.presets.*]` in config overrides them by name. */
export const DEFAULT_PRESETS: Readonly<Record<string, Preset>> = {
  // The driver asks the developer; it never splits its task, so atomize would only add a Decisions round trip.
  // Its turns are light (pick options, ask, reply), and thinking was ~80% of each turn's time.
  driver: { layer: ["Graph", "Gherkin", "Inquire", "Fs:read", "Decisions", "Rehearse", "Rlm"], spawns: ["research"], atomize: false, reasoning: false, role: "driver", budget: { turns: 25 }, result: "text", verify: "none" },
  // Plan and implement phases (the reconcile loop): each runs per card in its own worktree.
  plan: { layer: ["Graph", "Fs:read", "Decisions", "Rlm"], spawns: ["research"], role: "plan", budget: { turns: 20 }, result: "plan", verify: "none" },
  "implement-card": { layer: ["Graph", "Fs", "Sh", "Verify", "Rlm"], spawns: ["research"], role: "implement", budget: { turns: 25 }, result: "implement-card", verify: "gate" },
  fix: { layer: ["Graph", "Fs", "Sh", "Verify", "Rlm"], spawns: [], role: "implement", budget: { turns: 15 }, result: "text", verify: "none" },
  resolve: { layer: ["Fs", "Sh", "Rlm"], spawns: [], role: "implement", budget: { turns: 10 }, result: "resolve", verify: "none" },
  research: { layer: ["Graph", "Fs:read", "Decisions", "Rlm"], spawns: ["research"], role: "driver", budget: { turns: 15 }, result: "research", verify: "none" },
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
  /** The plan's Markdown sections (Approach, Files, Tests, Depends on), or why the card cannot be planned. */
  plan: Schema.Struct({ plan: Schema.optionalKey(Schema.String), blocked: Schema.optionalKey(Schema.String) }),
  "implement-card": Schema.Struct({ files: Schema.Array(Schema.String), summary: Schema.String, blocked: Schema.optionalKey(Schema.String) }),
  resolve: Schema.Struct({ resolved: Schema.Boolean }),
}
