import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Evidence, integrity, proofOf, readEvidence } from "../src/evidence"

const ev = (over: Partial<Evidence> = {}): Evidence => ({ scenario: "S-0001", version: "aaaaaaaaaaaa", commit: "abc1234", run: "e2e-1", journey: "J-0005", passed: true, flaky: false, at: "2026-10-04T00:00:00Z", ms: 10, media: [], failure: null, ...over })

test("proofOf: passed at this version is proven; failed is failing; another version is unproven; code changed after is stale", () => {
  expect(proofOf(ev(), "aaaaaaaaaaaa", false)).toBe("proven")
  expect(proofOf(ev({ passed: false }), "aaaaaaaaaaaa", false)).toBe("failing")
  expect(proofOf(ev(), "bbbbbbbbbbbb", false)).toBe("unproven")
  expect(proofOf(undefined, "aaaaaaaaaaaa", false)).toBe("unproven")
  expect(proofOf(ev(), "aaaaaaaaaaaa", true)).toBe("stale")
  // A failure stays failing even when code changed since: the next run decides.
  expect(proofOf(ev({ passed: false }), "aaaaaaaaaaaa", true)).toBe("failing")
})

test("readEvidence and integrity: orphans, bad files, missing media, unknown commits", () => {
  const root = mkdtempSync(join(tmpdir(), "zt-ev-"))
  const dir = join(root, ".zarg", "evidence")
  mkdirSync(join(dir, "media", "S-0001"), { recursive: true })
  writeFileSync(join(dir, "media", "S-0001", "after.txt"), "frame")
  writeFileSync(join(dir, "S-0001.json"), JSON.stringify(ev({ media: [{ kind: "buffer", path: "media/S-0001/after.txt", caption: "c" }, { kind: "cast", path: "media/S-0001/gone.cast", caption: "c" }] })))
  writeFileSync(join(dir, "S-0099.json"), JSON.stringify(ev({ scenario: "S-0099" })))
  writeFileSync(join(dir, "S-0002.json"), "{ not json")
  writeFileSync(join(dir, "S-0003.json"), JSON.stringify(ev({ scenario: "S-0003", commit: "deadbee" })))
  const entries = readEvidence(root)
  expect(entries.map((e) => [e.file, e.evidence?.scenario ?? null, e.error === undefined]).sort()).toEqual([["S-0001.json", "S-0001", true], ["S-0002.json", null, false], ["S-0003.json", "S-0003", true], ["S-0099.json", "S-0099", true]])
  const found = integrity(root, entries, new Set(["S-0001", "S-0002", "S-0003"]), (sha) => sha === "abc1234")
  expect(found.map((f) => [f.kind, f.file]).sort()).toEqual([["bad-evidence", "S-0002.json"], ["missing-media", "S-0001.json"], ["orphan-evidence", "S-0099.json"], ["unknown-commit", "S-0003.json"]])
  expect(readEvidence(mkdtempSync(join(tmpdir(), "zt-ev-none-")))).toEqual([])
})

test("binary media is gitignored by default: missing on this machine is not a problem, unless media is committed", () => {
  const root = mkdtempSync(join(tmpdir(), "zt-ev-bin-"))
  mkdirSync(join(root, ".zarg", "evidence"), { recursive: true })
  writeFileSync(join(root, ".zarg", "evidence", "S-0001.json"), JSON.stringify(ev({ media: [{ kind: "image", path: "media/S-0001/shot.png", caption: "c" }] })))
  const entries = readEvidence(root)
  expect(integrity(root, entries, new Set(["S-0001"]), () => true)).toEqual([])
  expect(integrity(root, entries, new Set(["S-0001"]), () => true, { commitBinary: true }).map((f) => f.kind)).toEqual(["missing-media"])
})

import { changedSince } from "../src/evidence"
test("changedSince (real git): a committed change, a rename, an uncommitted edit; nothing changed is not", () => {
  const root = mkdtempSync(join(tmpdir(), "zt-git-"))
  const git = (...a: Array<string>) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root }).stdout.toString().trim()
  git("init", "-q")
  writeFileSync(join(root, "a.ts"), "x\n")
  git("add", "-A")
  git("commit", "-qm", "1")
  const c = git("rev-parse", "--short", "HEAD")
  expect(changedSince(root, ["a.ts"], c)).toBe(false)
  expect(changedSince(root, [], c)).toBe(false)
  writeFileSync(join(root, "a.ts"), "y\n")
  expect(changedSince(root, ["a.ts"], c)).toBe(true)
  git("commit", "-qam", "2")
  expect(changedSince(root, ["a.ts"], c)).toBe(true)
  const c2 = git("rev-parse", "--short", "HEAD")
  git("mv", "a.ts", "b.ts")
  git("commit", "-qm", "3")
  expect(changedSince(root, ["b.ts"], c2)).toBe(true)
  expect(changedSince(root, ["a.ts"], "deadbee")).toBe(false)
})

import { codeChanged, codeOf } from "../src/evidence"
test("code by content: the tagged files' hashes at the run; an edit, a new or a gone file changes it; no commit is needed (squash, rebase, shallow clones)", () => {
  const root = mkdtempSync(join(tmpdir(), "zt-code-"))
  Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  writeFileSync(join(root, "a.ts"), "x\n")
  const code = codeOf(root, ["a.ts"])
  expect(Object.keys(code)).toEqual(["a.ts"])
  expect(code["a.ts"]).toMatch(/^[0-9a-f]{40}$/)
  const e = ev({ commit: "gone123", code })
  expect(codeChanged(root, ["a.ts"], e)).toBe(false)
  writeFileSync(join(root, "b.ts"), "y\n")
  expect(codeChanged(root, ["a.ts", "b.ts"], e)).toBe(true)
  expect(codeChanged(root, [], e)).toBe(true)
  writeFileSync(join(root, "a.ts"), "z\n")
  expect(codeChanged(root, ["a.ts"], e)).toBe(true)
  // With code recorded, a commit this clone lacks is no integrity problem.
  mkdirSync(join(root, ".zarg", "evidence"), { recursive: true })
  writeFileSync(join(root, ".zarg", "evidence", "S-0001.json"), JSON.stringify(e))
  expect(integrity(root, readEvidence(root), new Set(["S-0001"]), () => false)).toEqual([])
})

test("an evidence file named for another scenario is bad evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "zt-ev-name-"))
  mkdirSync(join(root, ".zarg", "evidence"), { recursive: true })
  writeFileSync(join(root, ".zarg", "evidence", "S-0001.json"), JSON.stringify(ev({ scenario: "S-0002" })))
  expect(integrity(root, readEvidence(root), new Set(["S-0001", "S-0002"]), () => true).map((f) => f.kind)).toEqual(["bad-evidence"])
})

test("text or binary comes from the declared kinds: a missing text medium is a problem, a missing binary one is not; old kinds through their aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "zt-ev-kinds-"))
  mkdirSync(join(root, ".zarg", "evidence"), { recursive: true })
  writeFileSync(join(root, ".zarg", "evidence", "S-0001.json"), JSON.stringify(ev({ media: [{ kind: "evidence-x/notes", path: "media/S-0001/1-notes.txt", caption: "n" }, { kind: "image", path: "media/S-0001/shot.png", caption: "s" }] })))
  const entries = readEvidence(root)
  const declared = (files: "text" | "binary") => ({ isText: (k: string) => k === "evidence-x/notes" && files === "text" })
  expect(integrity(root, entries, new Set(["S-0001"]), () => true, declared("text")).map((f) => f.detail)).toEqual(["evidence-x/notes media/S-0001/1-notes.txt"])
  expect(integrity(root, entries, new Set(["S-0001"]), () => true, declared("binary"))).toEqual([])
  expect(integrity(root, entries, new Set(["S-0001"]), () => true, { commitBinary: true, isText: () => false }).map((f) => f.detail)).toEqual(["evidence-x/notes media/S-0001/1-notes.txt", "image media/S-0001/shot.png"])
})
