import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { connect, isAlive, readInfo, startHeadless, stopCore } from "../src"

const command = [process.execPath, join(import.meta.dir, "fake-core.ts")]
const roots: Array<string> = []
const fresh = () => {
  const r = mkdtempSync(join(tmpdir(), "zarg-connect-"))
  roots.push(r)
  return r
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

describe("connect", () => {
  test("with no core running, starts a child core and stops it on close", async () => {
    const root = fresh()
    const c = await Effect.runPromise(connect({ root, command }))
    expect(c.owned).toBe(true)
    expect(c.info.mode).toBe("child")
    expect(isAlive(c.info.pid)).toBe(true)
    await c.close()
    expect(isAlive(c.info.pid)).toBe(false)
    expect(readInfo(root)).toBeUndefined()
  })

  test("attaches to a running core without owning it", async () => {
    const root = fresh()
    const first = await Effect.runPromise(connect({ root, command }))
    const second = await Effect.runPromise(connect({ root, command }))
    expect(second.owned).toBe(false)
    expect(second.info.pid).toBe(first.info.pid)
    await second.close()
    expect(isAlive(first.info.pid)).toBe(true)
    await first.close()
  })

  test("a core that fails to start reports its stderr", async () => {
    const root = fresh()
    process.env.FAKE_CORE = "fail"
    const err = await Effect.runPromise(Effect.flip(connect({ root, command }))).finally(() => delete process.env.FAKE_CORE)
    expect(err._tag).toBe("CoreStartError")
    expect(err.message).toContain("roles.driver is not set")
  })

  test("a headless core keeps running until stopCore", async () => {
    const root = fresh()
    const info = await Effect.runPromise(startHeadless({ root, command }))
    expect(info.mode).toBe("headless")
    expect((await Effect.runPromise(Effect.flip(startHeadless({ root, command })))).message).toContain("already running")
    expect(await Effect.runPromise(stopCore(root))).toBe(true)
    expect(isAlive(info.pid)).toBe(false)
    expect(await Effect.runPromise(stopCore(root))).toBe(false)
  })
})
