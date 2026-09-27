// packages/core/src/rehearse/settings.ts
export interface RehearseSettings {
  readonly feelBelow: number
  readonly failAt: number
  readonly forkBelow: number
  readonly seamBelow: number
  readonly realKeep: number
  readonly realDrop: number
  readonly inFlight: number
  /** The model for diagnosis and the report. */
  readonly role: string
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)

/** `[rehearse]` from the config, with the thresholds calibrated on 2026-09-27 as defaults. */
export const rehearseSettings = (extra: Readonly<Record<string, unknown>>, roles: Readonly<Record<string, string>>): RehearseSettings => {
  const r = (extra.rehearse ?? {}) as Record<string, unknown>
  return {
    feelBelow: num(r.feel_below, 1.45),
    failAt: num(r.fail_at, 0.8),
    forkBelow: num(r.fork_below, 0.8),
    seamBelow: num(r.seam_below, 0.3),
    realKeep: num(r.real_keep, 0.75),
    realDrop: num(r.real_drop, 0.25),
    inFlight: num(r.in_flight, 8),
    role: roles.rehearse ?? roles.driver ?? "",
  }
}
