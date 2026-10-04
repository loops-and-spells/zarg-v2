import { expect, test } from "bun:test"
import { Effect } from "effect"
import { makeEvidence } from "../src/server/evidence"

test("a plugin that hangs is waited for once: its other media get a reason at once, not a timeout each", async () => {
  let calls = 0
  const ev = makeEvidence({
    manifests: () => [{ name: "evidence-slow", scopes: { evidence: true }, evidence: { note: { label: "note", files: "text" } } } as never],
    waiting: () => [],
    assetsOf: () => ({}),
    invoke: () => {
      calls++
      return Effect.never
    },
    timeoutMs: 50,
  })
  const input = { kind: "evidence-slow/note", caption: "c", files: [] }
  const started = performance.now()
  const rs = await Effect.runPromise(Effect.all([ev.render(input), ev.render(input), ev.render(input)]))
  expect(calls).toBe(1)
  expect(performance.now() - started).toBeLessThan(500)
  expect(rs[0]).toMatchObject({ ok: false, reason: expect.stringContaining("evidence-slow could not render") })
  expect(rs[2]).toEqual({ ok: false, reason: "evidence-slow did not answer in time earlier; its media are not rendered" })
})
