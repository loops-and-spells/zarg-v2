import { Redacted } from "effect"

export interface SensitiveValue {
  readonly name: string
  readonly value: Redacted.Redacted<string>
}

/** Replace every sensitive value found in `text` with `<redacted:NAME>`. Longest values first. */
// @card S-0045
export const redact = (text: string, sensitive: ReadonlyArray<SensitiveValue>): string => {
  let out = text
  const byLength = [...sensitive].sort((a, b) => Redacted.value(b.value).length - Redacted.value(a.value).length)
  for (const s of byLength) {
    const raw = Redacted.value(s.value)
    if (raw.length > 0) out = out.split(raw).join(`<redacted:${s.name}>`)
  }
  return out
}

/** A copy of `env` without any variable whose name is sensitive. */
// @card S-0047
export const scrubEnv = (
  env: Readonly<Record<string, string | undefined>>,
  sensitive: ReadonlyArray<SensitiveValue>,
): Record<string, string> => {
  const names = new Set(sensitive.map((s) => s.name))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !names.has(k)) out[k] = v
  return out
}
