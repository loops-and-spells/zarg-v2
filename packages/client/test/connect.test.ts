import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { connect, infoPath, isAlive, readInfo, startHeadless, stopCore } from "../src"

const command = [process.execPath, join(import.meta.dir, "fake-core.ts")]
const roots: Array<string> = []
const fresh = () => {
  const r = mkdtempSync(join(tmpdir(), "zarg-connect-"))
  roots.push(r)
  return r
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

describe("connect", () => {
  // @scenario S-0088
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

  // @scenario S-0090
  test("one core per session: a core a live TUI owns is refused, naming --attach", async () => {
    const root = fresh()
    const first = await Effect.runPromise(connect({ root, command }))
    const err = await Effect.runPromise(Effect.flip(connect({ root, command })))
    expect(err.message).toBe(`a zarg session is running here (pid ${first.info.pid}); zarg --attach to join it, or quit it first`)
    await first.close()
  })

  // @scenario S-0091
  test("--attach joins a running core without owning it; with none it says so", async () => {
    const root = fresh()
    expect((await Effect.runPromise(Effect.flip(connect({ root, command, attach: true })))).message).toBe("no zarg core running here; start one with zarg")
    const first = await Effect.runPromise(connect({ root, command }))
    const second = await Effect.runPromise(connect({ root, command, attach: true }))
    expect(second.owned).toBe(false)
    expect(second.info.pid).toBe(first.info.pid)
    await second.close()
    expect(isAlive(first.info.pid)).toBe(true)
    await first.close()
  })

  // @scenario S-0090
  test("a headless core is refused by default, naming --attach and zarg core stop", async () => {
    const root = fresh()
    const info = await Effect.runPromise(startHeadless({ root, command }))
    expect((await Effect.runPromise(Effect.flip(connect({ root, command })))).message).toBe(`a headless core runs here (pid ${info.pid}); zarg --attach to join it, or zarg core stop`)
    await Effect.runPromise(stopCore(root))
  })

  // @scenario S-0089
  test("an orphaned core (its TUI is gone) is stopped and replaced by this session's own", async () => {
    const root = fresh()
    const gone = Bun.spawn(["true"])
    await gone.exited
    const orphan = Bun.spawn(["sleep", "30"])
    mkdirSync(join(root, ".zarg", "run"), { recursive: true })
    writeFileSync(infoPath(root), JSON.stringify({ pid: orphan.pid, socket: join(root, "x.sock"), token: "t", mode: "child", owner: gone.pid, ready: true }))
    const c = await Effect.runPromise(connect({ root, command }))
    expect(c.owned).toBe(true)
    expect(c.info.pid).not.toBe(orphan.pid)
    await orphan.exited
    expect(isAlive(orphan.pid)).toBe(false)
    await c.close()
  })

  // @scenario S-0089
  test("an orphaned core that does not stop when asked (wedged) is killed and replaced", async () => {
    const root = fresh()
    const gone = Bun.spawn(["true"])
    await gone.exited
    // A core's own command line: --root names this project.
    const orphan = Bun.spawn([process.execPath, "-e", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`, "--root", root])
    await Bun.sleep(300)
    mkdirSync(join(root, ".zarg", "run"), { recursive: true })
    writeFileSync(infoPath(root), JSON.stringify({ pid: orphan.pid, socket: join(root, "x.sock"), token: "t", mode: "child", owner: gone.pid, ready: true }))
    try {
      const c = await Effect.runPromise(connect({ root, command }))
      expect(c.info.pid).not.toBe(orphan.pid)
      await orphan.exited
      expect(isAlive(orphan.pid)).toBe(false)
      await c.close()
    } finally {
      orphan.kill(9)
    }
  }, 30_000)

  // @scenario S-0089
  test.if(process.platform === "linux")("a claim whose pid now names another program (the pid was reused) is never killed: the start is refused", async () => {
    const root = fresh()
    const gone = Bun.spawn(["true"])
    await gone.exited
    const other = Bun.spawn([process.execPath, "-e", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`])
    await Bun.sleep(300)
    mkdirSync(join(root, ".zarg", "run"), { recursive: true })
    writeFileSync(infoPath(root), JSON.stringify({ pid: other.pid, socket: join(root, "x.sock"), token: "t", mode: "child", owner: gone.pid, ready: true }))
    try {
      const err = await Effect.runPromise(Effect.flip(connect({ root, command })))
      expect(err.message).toContain("did not stop")
      expect(isAlive(other.pid)).toBe(true)
    } finally {
      other.kill(9)
    }
  }, 30_000)

  // @scenario S-0091
  test("a core that is still starting is waited for, then joined with --attach", async () => {
    const root = fresh()
    const socket = join(root, "core.sock")
    const server = Bun.serve({ unix: socket, fetch: () => Response.json([]) })
    mkdirSync(join(root, ".zarg", "run"), { recursive: true })
    const info = { pid: process.pid, socket, token: "t", mode: "headless" }
    writeFileSync(infoPath(root), JSON.stringify(info))
    setTimeout(() => writeFileSync(infoPath(root), JSON.stringify({ ...info, ready: true })), 300)
    const c = await Effect.runPromise(connect({ root, command: ["false"], attach: true }))
    server.stop(true)
    expect(c).toMatchObject({ owned: false, info: { pid: process.pid, ready: true } })
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
