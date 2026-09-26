import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { infoPath, readInfo } from "@zarg/client"
import { claim, release } from "../src"

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
    expect(readInfo(root)?.pid).toBe(process.pid)
    release(root, process.pid)
    expect(readInfo(root)).toBeUndefined()
  })
})
