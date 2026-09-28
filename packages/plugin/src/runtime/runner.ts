// The plugin process: lock down first, then load exactly one bundle into one Compartment whose
// only authority is `powers.call(name, args)`, a request to the host.
import "ses"
import { type Failure, type FromPlugin, powerTag, type ToPlugin } from "./protocol"

lockdown({ errorTaming: "unsafe", overrideTaming: "severe", consoleTaming: "unsafe", reporting: "none" })

const send = (m: FromPlugin) => process.send!(m)
let nextPower = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const powers = harden({
  call: (power: string, args: unknown) =>
    new Promise((resolve, reject) => {
      const id = ++nextPower
      waiting.set(id, { resolve, reject })
      send({ type: "power", id, power: String(power), args: JSON.parse(JSON.stringify(args ?? null)) })
    }),
})
let methods: Record<string, (p: unknown) => unknown> = {}
const running = new Map<number, { cancelled: boolean }>()

const fail = (tag: Failure["tag"], message: string): Failure => ({ tag, message })

const onCall = async (id: number, method: string, params: unknown) => {
  const fn = Object.hasOwn(methods, method) ? methods[method] : undefined
  if (typeof fn !== "function") return send({ type: "reply", id, ok: false, error: fail("UnknownMethod", `no method "${method}"`) })
  const state = { cancelled: false }
  running.set(id, state)
  try {
    const result = await fn(params)
    if (result !== null && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
      for await (const chunk of result as AsyncIterable<unknown>) {
        if (state.cancelled) break
        send({ type: "chunk", id, value: JSON.parse(JSON.stringify(chunk ?? null)) })
      }
      send({ type: "end", id })
    } else send({ type: "reply", id, ok: true, value: JSON.parse(JSON.stringify(result ?? null)) })
  } catch (e) {
    const err = e as { tag?: string; message?: string }
    send({ type: "reply", id, ok: false, error: fail(powerTag(err?.tag), String(err?.message ?? e)) })
  } finally {
    running.delete(id)
  }
}

process.on("message", (m: ToPlugin) => {
  if (m.type === "load") {
    try {
      const c = new Compartment({ globals: { console: harden({ log: (...a: Array<unknown>) => void powers.call("console.log", a.map(String).join(" ")) }) }, __options__: true })
      const module = { exports: {} as { default?: { serve?: (p: typeof powers) => Record<string, (p: unknown) => unknown>; name?: unknown; service?: unknown; archetype?: unknown } } }
      c.evaluate(`(function (module, exports, powers) {\n${m.bundle}\n})`)(module, module.exports, powers)
      const serve = module.exports.default?.serve
      if (typeof serve !== "function") throw new Error("the bundle has no default export with serve(powers)")
      const served = serve(powers) as unknown
      if (served === null || typeof served !== "object" || Array.isArray(served)) throw new Error("serve(powers) must return an object of methods")
      methods = served as typeof methods
      const d = module.exports.default!
      const str = (v: unknown) => (typeof v === "string" ? v : undefined)
      const identity = { name: str(d.name), service: str(d.service), archetype: str(d.archetype) }
      send({ type: "loaded", identity: Object.fromEntries(Object.entries(identity).filter(([, v]) => v !== undefined)) })
    } catch (e) {
      send({ type: "load-failed", message: String((e as Error)?.message ?? e) })
    }
  } else if (m.type === "call") void onCall(m.id, m.method, m.params)
  else if (m.type === "cancel") { const r = running.get(m.id); if (r) r.cancelled = true }
  else if (m.type === "power-reply") {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    if (w === undefined) return
    if (m.ok) w.resolve(m.value)
    else w.reject(Object.assign(new Error(m.error.message), { tag: m.error.tag }))
  }
})
send({ type: "ready" })
