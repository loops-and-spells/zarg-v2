import { readFileSync } from "node:fs"
import { type Capture, screenshot as shot, trace, video as videoOf } from "@zarg/evidence-capture"

type Request = { method(): string; url(): string; response(): Promise<{ status(): number } | null> }
/** What record() uses of a Playwright page, structurally (no dependency on Playwright). */
export interface PageLike {
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>
  on(event: "console", fn: (m: { type(): string; text(): string }) => void): unknown
  on(event: "request" | "requestfinished" | "requestfailed", fn: (r: Request) => void): unknown
  video?(): { path(): Promise<string> } | null
}

/** How long an action waits for its own requests still in flight. */
const IN_FLIGHT_MS = 10_000

type Entry = { readonly method: string; readonly url: string; readonly started: number; status?: number; ms?: number; readonly done: Promise<void>; finish: () => void }
type Seen = { console: Array<{ level: string; text: string }>; requests: Array<Entry> }

/** Records a page for evidence: actions as a trace (screenshot, console, requests), screenshots, the page's video. */
export const record = (page: PageLike) => {
  const t = trace("")
  let current: Seen | undefined
  // A request belongs to the action it started in, in the order it started.
  // null: started between actions, so it belongs to none.
  const open = new Map<Request, Entry | null>()
  const entry = (r: Request): Entry => {
    let finish = () => {}
    const done = new Promise<void>((resolve) => (finish = resolve))
    return { method: r.method(), url: r.url(), started: performance.now(), done, finish }
  }
  page.on("console", (m) => current?.console.push({ level: m.type(), text: m.text() }))
  page.on("request", (r) => {
    if (current === undefined) return void open.set(r, null)
    const e = entry(r)
    current.requests.push(e)
    open.set(r, e)
  })
  const finished = (failed: boolean) => (r: Request) => {
    if (open.get(r) === null) return void open.delete(r)
    let e: Entry | undefined = open.get(r) ?? undefined
    if (e === undefined) {
      // A finish whose start was not seen (a page recorded mid-request): it belongs to the action running now, if any.
      if (current === undefined) return
      e = entry(r)
      current.requests.push(e)
    }
    open.delete(r)
    const at = e
    void (failed ? Promise.resolve(null) : r.response().catch(() => null)).then((res) => {
      at.status = res?.status() ?? 0
      at.ms = Math.round(performance.now() - at.started)
      at.finish()
    })
  }
  page.on("requestfinished", finished(false))
  page.on("requestfailed", finished(true))
  return {
    /** Runs `fn`, then records the action: its screenshot, and the console and requests seen during it. */
    action: async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const started = performance.now()
      const at: Seen = { console: [], requests: [] }
      current = at
      let error: unknown
      try {
        await fn()
      } catch (e) {
        error = e
        at.console.push({ level: "error", text: `action failed: ${e instanceof Error ? e.message : String(e)}` })
      }
      current = undefined
      // Its own requests still in flight: waited for, up to a limit (one with no answer is recorded as status 0).
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.all(at.requests.map((e) => e.done)), new Promise<void>((r) => (timer = setTimeout(r, IN_FLIGHT_MS)))])
      clearTimeout(timer)
      // A page that cannot take a screenshot (closed, crashed) leaves the action without one.
      const png = await page.screenshot().catch(() => undefined)
      t.action(name, { ...(png === undefined ? {} : { screenshot: png }), console: at.console, requests: at.requests.map((e) => ({ method: e.method, url: e.url, status: e.status ?? 0, ...(e.ms === undefined ? {} : { ms: e.ms }) })), ms: Math.round(performance.now() - started) })
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
