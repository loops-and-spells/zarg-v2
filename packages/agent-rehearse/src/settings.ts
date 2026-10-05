export interface RehearseSettings {
  readonly feelBelow: number
  readonly failAt: number
  readonly forkBelow: number
  readonly seamBelow: number
  /** How sure the decision model must be that a step's code does what the step says; below, the step is flagged drift. */
  readonly driftBelow: number
  readonly realKeep: number
  readonly realDrop: number
  readonly inFlight: number
  /** The model role for diagnosis and the report. */
  readonly role: string
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)

/** The plugin's config (`[plugins.rehearse]`), with the thresholds calibrated on 2026-09-27 as defaults. */
export const rehearseSettings = (config: Readonly<Record<string, unknown>>, role: string): RehearseSettings => ({
  feelBelow: num(config.feel_below, 1.45),
  failAt: num(config.fail_at, 0.8),
  forkBelow: num(config.fork_below, 0.8),
  seamBelow: num(config.seam_below, 0.3),
  driftBelow: num(config.drift_below, 0.3),
  realKeep: num(config.real_keep, 0.75),
  realDrop: num(config.real_drop, 0.25),
  inFlight: num(config.in_flight, 8),
  role,
})
