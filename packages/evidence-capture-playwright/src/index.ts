import { readFileSync } from "node:fs"
import { type Capture, type TraceAction, screenshot as shot, trace, video as videoOf } from "@zarg/evidence-capture"

type Request = { method(): string; url(): string; response(): Promise<{ status(): number } | null> }
/** What record() uses of a Playwright page, structurally (no dependency on Playwright). */
export interface PageLike {
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>
  on(event: "console", fn: (m: { type(): string; text(): string }) => void): unknown
  on(event: "requestfinished" | "requestfailed", fn: (r: Request) => void): unknown
  video?(): { path(): Promise<string> } | null
}

/** Records a page for evidence: actions as a trace (screenshot, console, requests), screenshots, the page's video. */
export const record = (page: PageLike) => {
  const t = trace("")
type Seen = { console: Array<{ level: string; text: string }>; requests: Array<NonNullable<TraceAction["requests"]>[number] | undefined>; pending: Array<Promise<void>> }
  let current: Seen | undefined
  page.on("console", (m) => current?.console.push({ level: m.type(), text: m.text() }))
  const onRequest = (failed: boolean) => (r: Request) => {
    const at = current
    if (at === undefined) return
    const started = performance.now()
    // Requests keep the order they started in, however their responses arrive.
    const slot = at.requests.push(undefined) - 1
    at.pending.push(
      (failed ? Promise.resolve(null) : r.response().catch(() => null)).then((res) => {
        at.requests[slot] = { method: r.method(), url: r.url(), status: res?.status() ?? 0, ms: Math.round(performance.now() - started) }
      }),
    )
  }
  page.on("requestfinished", onRequest(false))
  page.on("requestfailed", onRequest(true))
  return {
    /** Runs `fn`, then records the action: its screenshot, and the console and requests seen during it. */
    action: async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const started = performance.now()
      const at: Seen = { console: [], requests: [], pending: [] }
      current = at
      let error: unknown
      try {
        await fn()
      } catch (e) {
        error = e
        at.console.push({ level: "error", text: `action failed: ${e instanceof Error ? e.message : String(e)}` })
      }
      await Promise.all(at.pending)
      current = undefined
      // A page that cannot take a screenshot (closed, crashed) leaves the action without one.
      const png = await page.screenshot().catch(() => undefined)
      t.action(name, { ...(png === undefined ? {} : { screenshot: png }), console: at.console, requests: at.requests.filter((x) => x !== undefined), ms: Math.round(performance.now() - started) })
      if (error !== undefined) throw error
    },
    screenshot: async (caption: string): Promise<Capture> => shot(caption, await page.screenshot({ fullPage: true })),
    trace: (caption: string): Capture => ({ ...t.done(), caption }),
    /** The page's video (once the page has closed and Playwright has written it). */
    video: async (caption: string): Promise<Capture | undefined> => {
      const v = page.video?.()
      return v ? videoOf(caption, new Uint8Array(readFileSync(await v.path())), "video/webm") : undefined
    },
  }
}
