import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { infoPath, readClaim, readInfo } from "@zarg/client"
import { claim, markReady, release } from "../src"

const roots: Array<string> = []
const fresh = () => {
  const r = mkdtempSync(join(tmpdir(), "zarg-life-"))
  roots.push(r)
  return r
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

describe("core.json", () => {
  test("claim writes a private file; a second live core is refused", () => {
    const root = fresh()
    expect(claim(root, { pid: process.pid, socket: "s", token: "t", mode: "child" })).toEqual({ ok: true })
    expect(statSync(infoPath(root)).mode & 0o777).toBe(0o600)
    const other = claim(root, { pid: 1, socket: "s", token: "t", mode: "headless" })
    expect(other).toMatchObject({ ok: false })
  })

  test("a file left by a dead core is ignored", () => {
    const root = fresh()
    mkdirSync(join(root, ".zarg", "run"), { recursive: true })
    writeFileSync(infoPath(root), JSON.stringify({ pid: 999999, socket: "s", token: "t", mode: "child" }))
    expect(readInfo(root)).toBeUndefined()
    expect(claim(root, { pid: process.pid, socket: "s", token: "t", mode: "child" })).toEqual({ ok: true })
  })

  test("release removes the file only for its own pid", () => {
    const root = fresh()
    claim(root, { pid: process.pid, socket: "s", token: "t", mode: "child" })
    release(root, 12345)
    expect(readClaim(root)?.pid).toBe(process.pid)
    release(root, process.pid)
    expect(readClaim(root)).toBeUndefined()
  })

  test("a claim is visible to clients only once the core is ready", () => {
    const root = fresh()
    const info = { pid: process.pid, socket: "s", token: "t", mode: "child" as const }
    claim(root, info)
    expect(readInfo(root)).toBeUndefined()
    expect(readClaim(root)?.pid).toBe(process.pid)
    markReady(root, info)
    expect(readInfo(root)).toMatchObject({ pid: process.pid, ready: true })
    expect(statSync(infoPath(root)).mode & 0o777).toBe(0o600)
  })

  test("claims racing from several processes: exactly one wins", async () => {
    const root = fresh()
    const script = `import { claim } from ${JSON.stringify(join(import.meta.dir, "..", "src", "lifecycle.ts"))}
await Bun.sleep(Number(process.argv[2]) - Date.now())
const r = claim(${JSON.stringify(root)}, { pid: process.pid, socket: "s", token: "t", mode: "child" })
console.log(r.ok ? "won" : "lost")
await Bun.sleep(500)`
    const file = join(root, "claim.ts")
    writeFileSync(file, script)
    const at = Date.now() + 700
    const procs = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, file, String(at)], { stdout: "pipe" }))
    const results = await Promise.all(procs.map((p) => new Response(p.stdout).text()))
    expect(results.filter((r) => r.trim() === "won")).toHaveLength(1)
  }, 20_000)

  test("a claim by a live core that is still starting is never overwritten", () => {
    const root = fresh()
    mkdirSync(join(root, ".zarg", "run"), { recursive: true })
    writeFileSync(infoPath(root), JSON.stringify({ pid: 1, socket: "s", token: "t", mode: "child" }))
    expect(claim(root, { pid: process.pid, socket: "s", token: "t", mode: "child" })).toMatchObject({ ok: false })
    expect(readClaim(root)?.pid).toBe(1)
  })
})
