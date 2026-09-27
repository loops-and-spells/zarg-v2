// The spike's hostile probes, kept for good: each must be blocked inside the real runtime.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { spawnPlugin } from "../src/runtime"
import { bundle } from "./fixtures"

const probes: Record<string, string> = {
  process: `typeof process === "undefined" ? "blocked" : "REACHED"`,
  Bun: `typeof Bun === "undefined" ? "blocked" : "REACHED"`,
  require: `typeof require === "undefined" ? "blocked" : "REACHED"`,
  globalFetch: `typeof fetch === "undefined" ? "blocked" : "REACHED"`,
  functionCtor: `(() => { try { return (function(){}).constructor("return typeof process")() === "undefined" ? "blocked" : "REACHED" } catch { return "blocked" } })()`,
  indirectEvalProcess: `(0, eval)("typeof process") === "undefined" ? "blocked" : "REACHED"`,
  prototypePollution: `(() => { try { Object.prototype.zt = 1; return "REACHED" } catch { return "blocked" } })()`,
  patchJSON: `(() => { try { JSON.stringify = () => "x"; return "REACHED" } catch { return "blocked" } })()`,
  mutatePowers: `(() => { try { powers.call = () => "stolen"; return "REACHED" } catch { return "blocked" } })()`,
}

describe("escape suite", () => {
  for (const [name, expr] of Object.entries(probes)) {
    test(`${name} is blocked`, async () => {
      const r = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const p = yield* spawnPlugin({ name: "hostile", bundle: bundle(`{ probe: async () => ${expr} }`), powers: {} })
        return yield* p.call("probe", {})
      })))
      expect(r).toBe("blocked")
    })
  }
  test("code containing import(...) is refused before it runs", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.flip(spawnPlugin({ name: "imp", bundle: bundle(`{ x: async () => import("node:fs") }`), powers: {} }))))
    expect(e.message).toMatch(/import/)
  })
  test("code containing direct eval(...) is refused before it runs", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.flip(spawnPlugin({ name: "ev", bundle: bundle(`{ x: async () => eval("1") }`), powers: {} }))))
    expect(e.message).toMatch(/eval/)
  })
})
