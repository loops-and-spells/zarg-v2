import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Evidence, text, trace } from "../src"
import { clearStale, commit, stage } from "../src/writer"

const evidence = (media: Evidence["media"]): Evidence => ({ scenario: "S-0001", version: "aaaaaaaaaaaa", commit: "abc1234", run: "r", journey: "J-1", passed: true, flaky: false, at: "t", ms: 1, media, failure: null })

// @scenario S-0115
test("captures are staged, then swapped in with the evidence; a trace's other files are listed", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-writer-"))
  const s = stage(dir, "S-0001", "1")
  expect(s.attach(text("agenda", "[]"))).toEqual({ kind: "evidence-terminal/text", caption: "agenda", path: "media/S-0001/1-text.txt" })
  const t = trace("save")
  t.action("a", { screenshot: new Uint8Array([1, 2]) })
  t.action("b", { screenshot: new Uint8Array([3]) })
  expect(s.attach(t.done())).toEqual({ kind: "evidence-screen/trace", caption: "save", path: "media/S-0001/2-trace.json", meta: { files: ["media/S-0001/2-001.png", "media/S-0001/2-002.png"] } })
  expect(existsSync(join(dir, "S-0001.json"))).toBe(false)
  commit(dir, s, evidence(s.media()))
  const written = JSON.parse(readFileSync(join(dir, "S-0001.json"), "utf8")) as Evidence
  expect(written.media.map((m) => m.path)).toEqual(["media/S-0001/1-text.txt", "media/S-0001/2-trace.json"])
  expect(readFileSync(join(dir, "media/S-0001/1-text.txt"), "utf8")).toBe("[]")
  expect([...readFileSync(join(dir, "media/S-0001/2-001.png"))]).toEqual([1, 2])
  expect(readdirSync(join(dir, "media")).filter((d) => d.startsWith("."))).toEqual([])
})

test("a run killed before its commit leaves the last evidence whole; its staging is cleared next time", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-writer-"))
  const a = stage(dir, "S-0001", "1")
  a.attach(text("from A", "A"))
  commit(dir, a, evidence(a.media()))
  const b = stage(dir, "S-0001", "2")
  b.attach(text("from B", "B"))
  // killed: no commit
  clearStale(dir, "S-0001")
  expect(readdirSync(join(dir, "media")).filter((d) => d.startsWith("."))).toEqual([])
  expect(readFileSync(join(dir, "media/S-0001/1-text.txt"), "utf8")).toBe("A")
  expect((JSON.parse(readFileSync(join(dir, "S-0001.json"), "utf8")) as Evidence).media[0]!.caption).toBe("from A")
})

test("evidence with no media: the scenario's old media goes", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-writer-"))
  const a = stage(dir, "S-0001", "1")
  a.attach(text("x", "x"))
  commit(dir, a, evidence(a.media()))
  commit(dir, undefined, evidence([]))
  expect(existsSync(join(dir, "media/S-0001"))).toBe(false)
})

test("a capture's file names are file names: one that is a path is refused, nothing written outside staging", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-writer-"))
  const s = stage(dir, "S-0001", "1")
  expect(() => s.attach({ kind: "evidence-x/y", caption: "c", files: { "../../escape.txt": "x" } })).toThrow('capture "c": file "../../escape.txt" is not a file name')
  expect(existsSync(join(dir, "escape.txt"))).toBe(false)
})
