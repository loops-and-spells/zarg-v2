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
})

export interface RlmSettings {
  readonly maxDepth: number
  readonly maxConcurrent: number
  /** `[rlm.atomize] min_confidence`: how sure a "no" must be to plan, and a "decision" check to pass. */
  readonly minConfidence: number
  readonly presets: Readonly<Record<string, Preset>>
}

export const DEFAULT_BUDGET: Budget = { turns: 25, tokens: 400_000, wallMs: 30 * 60_000 }

/** The presets from the spec; `[rlm.presets.*]` in config overrides them by name. */
export const DEFAULT_PRESETS: Readonly<Record<string, Preset>> = {
  driver: { layer: ["Graph", "Gherkin", "Inquire", "Fs:read", "Decisions", "Rlm"], spawns: ["research", "driver"], role: "driver", budget: { turns: 25 }, result: "text", verify: "none" },
  sync: { layer: ["Graph", "Fs", "Sh", "Verify", "Agenda", "Decisions", "Rlm"], spawns: ["implement-card", "research"], role: "sync", budget: { turns: 40 }, result: "text", verify: "gate" },
  "implement-card": { layer: ["Graph", "Fs", "Sh", "Verify", "Rlm"], spawns: ["research"], role: "sync", budget: { turns: 25 }, result: "implement-card", verify: "gate" },
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
    return { maxDepth: cfg.max_depth ?? 4, maxConcurrent: cfg.max_concurrent ?? 8, minConfidence: cfg.atomize?.min_confidence ?? 0.5, presets } satisfies RlmSettings
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
  "implement-card": Schema.Struct({ files: Schema.Array(Schema.String), summary: Schema.String }),
}
