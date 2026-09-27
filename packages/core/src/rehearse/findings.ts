// packages/core/src/rehearse/findings.ts
import { createHash } from "node:crypto"
import { Effect, Stream } from "effect"
import type { Model } from "@zarg/model"
import { stepText, storyText } from "./screen"
import type { Finding, Kind, Persona, Reason, StepView } from "./types"

const KINDS: ReadonlyArray<Kind> = ["friction", "gap", "contradiction", "transition", "feature", "delight"]
const SEVERITIES = ["high", "medium", "low"] as const
const MAX_PER_STEP = 5

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: MAX_PER_STEP,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "severity", "note"],
        properties: {
          kind: { enum: KINDS },
          severity: { enum: SEVERITIES },
          note: { type: "string" },
          edge: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false },
          op: { type: "object" },
        },
      },
    },
  },
}

const WHY: Record<Reason, string> = {
  feel: "the step felt off",
  fail: "it could go wrong and nothing covers that",
  fork: "the choice after it is unclear",
  seam: "the Given may not follow from how you got here",
}

const textOf = (model: Model.Model["Service"], ref: string, system: string, user: string, outputSchema?: Record<string, unknown>) =>
  Stream.runCollect(model.stream({ model: ref, messages: [{ role: "system", content: system }, { role: "user", content: user }], ...(outputSchema ? { outputSchema } : {}), maxTokens: 2048 })).pipe(
    Effect.map((events) => [...events].flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")),
  )

type Raw = { readonly kind: Kind; readonly card: string; readonly edge?: { from: string; to: string }; readonly severity: "high" | "medium" | "low"; readonly note: string; readonly op?: unknown }

/** A flagged step, looked at by a large-model tester in the persona's shoes. */
export const diagnose = (model: Model.Model["Service"], ref: string, persona: Persona, prior: ReadonlyArray<StepView>, step: StepView, flags: ReadonlyArray<Reason>) =>
  textOf(
    model,
    ref,
    `You ARE ${persona.text}. You are walking a product's specified journey, one step at a time, and report what is wrong with this step for you: friction (unclear), gap (something missing, like a failure you must handle), contradiction, transition (the step does not follow from the one before), feature (something you would want), delight. At most ${MAX_PER_STEP}; notes of two sentences at most. Suggest a graph change in op when you can. Most steps are fine: report nothing then.`,
    `So far: ${storyText(prior) || "you just started"}.\nThis step:\n${stepText(step)}\nIt was flagged because ${flags.map((f) => WHY[f]).join(" and ")}.`,
    FINDINGS_SCHEMA,
  ).pipe(
    Effect.map((text) => {
      try {
        const j = JSON.parse(text) as { findings?: ReadonlyArray<Partial<Raw>> }
        const findings = (j.findings ?? []).slice(0, MAX_PER_STEP).flatMap((f) =>
          KINDS.includes(f.kind as Kind) && SEVERITIES.includes(f.severity as never) && typeof f.note === "string"
            ? [{ kind: f.kind as Kind, card: step.card, ...(f.edge ? { edge: f.edge } : {}), severity: f.severity as Raw["severity"], note: f.note, ...(f.op !== undefined ? { op: f.op } : {}) }]
            : [],
        )
        return { findings }
      } catch {
        return { findings: [{ kind: "friction" as const, card: step.card, severity: "low" as const, note: `the tester answered in prose: ${text.slice(0, 300)}` }] }
      }
    }),
    // Never a finding: a model or transport failure is noted for the run, so no one fixes a ghost.
    Effect.catch((e: { readonly message?: string }) => Effect.succeed({ infra: `${step.card}: ${e.message ?? String(e)}` })),
  )

export const findingId = (kind: Kind, card: string, edge?: { from: string; to: string }) =>
  `R-${createHash("sha256").update(`${kind}|${card}|${edge ? `${edge.from}>${edge.to}` : ""}`).digest("hex").slice(0, 8)}`

const RANK = { high: 3, medium: 2, low: 1 } as const

/** One finding per kind and place: the strongest severity, every note (three at most), who reported it. */
export const consolidate = (raw: ReadonlyArray<Raw & { readonly persona: string }>): ReadonlyArray<Finding> => {
  const byId = new Map<string, Finding>()
  for (const r of raw) {
    const id = findingId(r.kind, r.card, r.edge)
    const prev = byId.get(id)
    byId.set(
      id,
      prev === undefined
        ? { id, kind: r.kind, card: r.card, ...(r.edge ? { edge: r.edge } : {}), severity: r.severity, notes: [r.note], ...(r.op !== undefined ? { op: r.op } : {}), count: 1, personas: [r.persona] }
        : {
            ...prev,
            severity: RANK[r.severity] > RANK[prev.severity] ? r.severity : prev.severity,
            notes: prev.notes.length < 3 && !prev.notes.includes(r.note) ? [...prev.notes, r.note] : prev.notes,
            count: prev.count + 1,
            personas: prev.personas.includes(r.persona) ? prev.personas : [...prev.personas, r.persona],
            ...(prev.op === undefined && r.op !== undefined ? { op: r.op } : {}),
          },
    )
  }
  return [...byId.values()]
}

/** A few sentences for the driver: what the testers met. */
export const report = (model: Model.Model["Service"], ref: string, findings: ReadonlyArray<Finding>, stats: { steps: number; flagged: number; unscreened: number }) =>
  textOf(
    model,
    ref,
    "Summarise a rehearsal of a product's journeys for the product's driver in three to five sentences: where testers stalled, what is missing, what they liked. No lists.",
    `${stats.steps} steps walked, ${stats.flagged} flagged, ${stats.unscreened} unscreened.\nFindings:\n${findings.map((f) => `- ${f.kind} (${f.severity}) on ${f.card}: ${f.notes.join(" / ")}`).join("\n") || "none"}`,
  ).pipe(Effect.catch((e: { readonly message?: string }) => Effect.succeed(`(report unavailable: ${e.message ?? String(e)})`)))
