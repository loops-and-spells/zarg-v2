import { Effect, Schema } from "effect"
import { make } from "./kernel"
import type { RecordedCall } from "./kernel"
import type { TickSource, TickValue } from "./ticks"
import { bind, type ServiceDef } from "./service"

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v)

export interface Divergence { readonly at: number; readonly service: string; readonly method: string; readonly params: unknown; readonly reason: "no matching recorded call" }
export interface ReplayResult { readonly ok: boolean; readonly output: string; readonly divergences: ReadonlyArray<Divergence>; readonly unused: ReadonlyArray<RecordedCall>; readonly extraTicks: ReadonlyArray<TickSource> }

/**
 * Run code against a recording: every service answers from `calls` (the first unused call with the same
 * service, method and params, so concurrent calls may come in any order), and time and randomness come
 * from `ticks`. No model, network or real time is involved.
 */
export const replay = (opts: { readonly code: string; readonly defs: ReadonlyArray<ServiceDef>; readonly calls: ReadonlyArray<RecordedCall>; readonly ticks: ReadonlyArray<{ readonly source: TickSource; readonly value: TickValue }>; readonly timeoutMs?: number }) =>
  Effect.scoped(Effect.gen(function* () {
    const used = new Set<number>()
    const divergences: Array<Divergence> = []
    const extraTicks: Array<TickSource> = []
    let seen = 0
    /** One method's recorded answer: the first unused call with the same service, method and params. */
    const answer = (def: ServiceDef, method: string) => (decoded: unknown) =>
      Effect.gen(function* () {
        const spec = def.methods[method]!
        const at = seen++
        const params = spec.json ? decoded : Schema.encodeUnknownSync(Schema.toCodecJson(spec.params))(decoded)
        const key = canonical(params)
        const i = opts.calls.findIndex((c, n) => !used.has(n) && c.service === def.name && c.method === method && canonical(c.params) === key)
        if (i < 0) {
          divergences.push({ at, service: def.name, method, params, reason: "no matching recorded call" })
          return yield* Effect.fail({ _tag: "ReplayDivergence", message: `${def.name}.${method}: no recorded call with these params` })
        }
        used.add(i)
        const c = opts.calls[i]!
        if (!c.ok) return yield* Effect.fail(c.failure!)
        return spec.json ? c.result : Schema.decodeUnknownSync(Schema.toCodecJson(spec.success))(c.result)
      })
    const bounds = opts.defs.map((def) => bind(def, Object.fromEntries(Object.keys(def.methods).map((m) => [m, answer(def, m)])) as never))
    const kernel = yield* make({ services: bounds, clock: { mode: "replay", ticks: opts.ticks }, record: (r) => { if (r.kind === "extra") extraTicks.push(r.source) }, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) })
    const out = yield* kernel.run(opts.code)
    return { ok: out.ok, output: out.output, divergences, unused: opts.calls.filter((_, n) => !used.has(n)), extraTicks } satisfies ReplayResult
  }))
