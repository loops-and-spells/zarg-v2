import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { Effect } from "effect"
import { isAlive, readInfo } from "@zarg/client"
import { App } from "@zarg/view-tui"
import { openSession } from "../src/tui/run"

const root = mkdtempSync(join(tmpdir(), "zarg-tui-e2e-"))
writeFileSync(join(root, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
afterAll(() => rmSync(root, { recursive: true, force: true }))

// The driver's model turns: ask, finish the item with the answer, then ask what next.
const cells = [
  'const a = yield* Inquire.ask({ question: "Which card first?", options: [{ id: "login", label: "Login" }, { id: "checkout", label: "Checkout", recommended: true, why: "most used" }] })\nreturn a',
  'yield* Rlm.done({ value: "Working on Checkout." })',
  'const b = yield* Inquire.ask({ question: "What next?", options: [{ id: "x", label: "Payments" }, { id: "y", label: "Refunds" }] })\nreturn b',
]

/** Render until a frame matches; the core runs in another process, so wait by time, not by render passes. */
const frameUntil = async (t: Awaited<ReturnType<typeof testRender>>, match: (frame: string) => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    await t.renderOnce()
    const frame = t.captureCharFrame()
    if (match(frame)) return frame
    if (Date.now() > deadline) throw new Error(`no matching frame within ${ms}ms; last frame:\n${frame}`)
    await Bun.sleep(50)
  }
}

describe("tui end to end", () => {
  test("against a child core on the stub model: answer an inquiry by keys; exiting stops the core", async () => {
    const stub = join(root, "stub.json")
    writeFileSync(stub, JSON.stringify({ cells }))
    process.env.ZARG_CORE_STUB = stub
    const opened = await Effect.runPromise(openSession({ root, threadId: "main", focus: [] })).finally(() => delete process.env.ZARG_CORE_STUB)
    const pid = readInfo(root)!.pid
    let exited = false
    const t = await testRender(<App session={opened.session} meta={opened.meta} onExit={() => (exited = true)} />, { width: 110, height: 26, exitOnCtrlC: false, exitSignals: [] })
    try {
      opened.session.start()
      // Rehearse has no load grant in this test's user dir: zarg asks first. Not now keeps it unloaded.
      await frameUntil(t, (f) => f.includes("Plugin rehearse wants to load"))
      t.mockInput.pressArrow("down")
      await t.renderOnce()
      t.mockInput.pressEnter()
      await frameUntil(t, (f) => f.includes("› Checkout (recommended) — most used"))
      t.mockInput.pressEnter()
      const frame = await frameUntil(t, (f) => f.includes("What next?"))
      expect(frame).toContain("you  Checkout")
      expect(frame).toContain("zarg  Working on Checkout.")
      expect(frame).toContain("core child")
      // A second client attaches to the same core (it does not own it) and sees the pending question.
      const second = await Effect.runPromise(openSession({ root, threadId: "main", focus: [] }))
      second.session.start()
      const until = Date.now() + 10_000
      while (second.session.state().thread.pendingInquiry?.question !== "What next?" && Date.now() < until) await Bun.sleep(50)
      expect(second.session.state().thread.pendingInquiry?.question).toBe("What next?")
      await second.close()
      expect(isAlive(pid)).toBe(true)
      t.mockInput.pressKey("d", { ctrl: true })
      await t.renderOnce()
      expect(exited).toBe(true)
    } finally {
      t.renderer.destroy()
      await opened.close()
    }
    expect(isAlive(pid)).toBe(false)
  }, 30_000)
})
