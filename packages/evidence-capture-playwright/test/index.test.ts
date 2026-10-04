import { expect, test } from "bun:test"
import { record } from "../src"

/** A page that answers like Playwright's, driven by the test. */
const fakePage = (opts: { readonly shots?: () => Promise<Uint8Array>; readonly video?: Uint8Array } = {}) => {
  const handlers = new Map<string, Array<(x: unknown) => void>>()
  let n = 0
  const page = {
    screenshot: opts.shots ?? (async () => new Uint8Array([++n])),
    on: (event: string, fn: (x: unknown) => void) => void handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    ...(opts.video === undefined ? {} : { video: () => ({ path: async () => { const f = `${require("node:os").tmpdir()}/zt-video-${Date.now()}.webm`; require("node:fs").writeFileSync(f, opts.video!); return f } }) }),
  }
  const emit = (event: string, x: unknown) => (handlers.get(event) ?? []).forEach((fn) => fn(x))
  const request = (method: string, url: string, status: number | null) => ({ method: () => method, url: () => url, response: async () => (status === null ? null : { status: () => status }) })
  return { page, emit, request }
}

test("each action: its screenshot, and the console and requests seen during it, in order", async () => {
  const { page, emit, request } = fakePage()
  const rec = record(page as never)
  await rec.action("open /plans", async () => {})
  await rec.action("click Save", async () => {
    emit("console", { type: () => "error", text: () => "boom" })
    emit("requestfinished", request("POST", "/api/save", 500))
    emit("requestfailed", request("GET", "/api/x", null))
  })
  const c = rec.trace("saving a plan")
  expect(c.kind).toBe("evidence-screen/trace")
  const steps = JSON.parse(c.files["trace.json"] as string)
  expect(steps.map((s: { action: string; screenshot?: string }) => [s.action, s.screenshot])).toEqual([["open /plans", "001.png"], ["click Save", "002.png"]])
  expect(steps[1].console).toEqual([{ level: "error", text: "boom" }])
  expect(steps[1].requests.map((r: { method: string; url: string; status: number }) => [r.method, r.url, r.status])).toEqual([["POST", "/api/save", 500], ["GET", "/api/x", 0]])
  expect(steps.every((s: { ms: number }) => typeof s.ms === "number" && s.ms >= 0)).toBe(true)
})

test("an action that throws is recorded with its error, then rethrown; a screenshot that fails leaves the action without one", async () => {
  const { page } = fakePage({ shots: async () => Promise.reject(new Error("page closed")) })
  const rec = record(page as never)
  await expect(rec.action("click Gone", async () => { throw new Error("no such button") })).rejects.toThrow("no such button")
  const steps = JSON.parse(rec.trace("t").files["trace.json"] as string)
  expect(steps).toEqual([{ action: "click Gone", console: [{ level: "error", text: "action failed: no such button" }], requests: [], ms: expect.any(Number) }])
})

test("a screenshot on its own; video only when the page records one", async () => {
  const { page } = fakePage()
  expect((await record(page as never).screenshot("home")).kind).toBe("evidence-screen/screenshot")
  expect(await record(page as never).video("run")).toBeUndefined()
  const withVideo = fakePage({ video: new Uint8Array([9, 9]) })
  expect(await record(withVideo.page as never).video("run")).toMatchObject({ kind: "evidence-screen/video", files: { "video.webm": new Uint8Array([9, 9]) } })
})

test("a request belongs to the action it started in, its time from start to finish; one still in flight is waited for", async () => {
  const { page, emit } = fakePage()
  const rec = record(page as never)
  const slow = { method: () => "POST", url: () => "/api/slow", response: async () => ({ status: () => 201 }) }
  await rec.action("submit", async () => {
    emit("request", slow)
    // finishes 30 ms later, after the action's own work is done
    setTimeout(() => emit("requestfinished", slow), 30)
  })
  const late = { method: () => "GET", url: () => "/api/late", response: async () => ({ status: () => 200 }) }
  emit("request", late)
  await rec.action("next", async () => {
    emit("requestfinished", late)
  })
  const steps = JSON.parse(rec.trace("t").files["trace.json"] as string)
  expect(steps[0].requests.map((r: { url: string; status: number }) => [r.url, r.status])).toEqual([["/api/slow", 201]])
  expect(steps[0].requests[0].ms).toBeGreaterThanOrEqual(25)
  // A request started between actions belongs to none: it never lands in the next one.
  expect(steps[1].requests).toEqual([])
})
