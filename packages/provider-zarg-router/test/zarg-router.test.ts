import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeZargRouter } from "../src"

const recording = (reply: (url: string, body: any) => Response) => {
  const calls: Array<{ url: string; body: any }> = []
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    return reply(url, body)
  }) as unknown as typeof fetch
  return { calls, provider: makeZargRouter(f) }
}

describe("zarg-router provider", () => {
  test("warm posts the model id to /admin/warm at the router's origin", async () => {
    const r = recording(() => Response.json({ model: "m", state: "running" }))
    const client = await Effect.runPromise(r.provider.connect({ base_url: "http://router.test:11435/api/v1/" }))
    await Effect.runPromise(client.warm!("deepseek-v4.1-flash-exl3"))
    expect(r.calls).toEqual([{ url: "http://router.test:11435/admin/warm", body: { model: "deepseek-v4.1-flash-exl3" } }])
  })

  test("a failed warm-up is a status error with the router's reason", async () => {
    const r = recording(() => Response.json({ error: "boot timed out" }, { status: 504 }))
    const client = await Effect.runPromise(r.provider.connect({ base_url: "http://router.test/api/v1" }))
    const err = await Effect.runPromise(Effect.flip(client.warm!("m")))
    expect(err).toMatchObject({ kind: "status", status: 504 })
    expect(err.message).toContain("boot timed out")
  })

  test("systemone posts to /api/v1/systemone and returns the JSON", async () => {
    const r = recording(() => Response.json({ answers: { q: { type: "noul", noul: 0.9 } } }))
    const client = await Effect.runPromise(r.provider.connect({ base_url: "http://router.test/api/v1" }))
    const out = await Effect.runPromise(client.systemone!({ model: "jevk5", state: "s", questions: {} }))
    expect(out).toEqual({ answers: { q: { type: "noul", noul: 0.9 } } })
    expect(r.calls[0]?.url).toBe("http://router.test/api/v1/systemone")
  })
})
