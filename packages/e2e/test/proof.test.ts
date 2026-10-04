import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "zt-proof-"))
  const nodes = join(root, ".zarg", "graph", "nodes")
  mkdirSync(nodes, { recursive: true })
  const w = (id: string, n: unknown) => writeFileSync(join(nodes, `${id}.json`), JSON.stringify(n))
  w("ST-0001", { id: "ST-0001", type: "gherkin/state", props: { text: "a" }, edges: [] })
  w("J-0001", { id: "J-0001", type: "gherkin/journey", props: { name: "J" }, edges: [] })
  w("J-0002", { id: "J-0002", type: "gherkin/journey", props: { name: "K" }, edges: [] })
  for (const [id, j] of [["S-0001", "J-0001"], ["S-0002", "J-0001"], ["S-0003", "J-0002"]] as const)
    w(id, { id, type: "gherkin/scenario", props: { title: id, when: "w" }, edges: [{ type: "gherkin/arrives", to: "ST-0001" }, { type: "gherkin/then", to: "ST-0001" }, { type: "gherkin/in", to: j }] })
  Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "g", "--allow-empty"], { cwd: root })
  return root
}
const runJourney = (root: string, body: string, env: Record<string, string> = {}) => {
  const file = join(root, "j.test.ts")
  writeFileSync(file, `import { journey } from "${join(import.meta.dir, "../src")}"\n${body}`)
  return Bun.spawnSync([process.execPath, "test", file], { cwd: root, env: { ...process.env, E2E_EVIDENCE_ROOT: root, E2E_KEEP_FAILED: "0", ...env } })
}
const evidence = (root: string, id: string) => JSON.parse(readFileSync(join(root, ".zarg", "evidence", `${id}.json`), "utf8"))

test("a passing CLI step writes evidence at the scenario's version with its notes as media", () => {
  const root = repo()
  runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0001", async (s) => { const r = await s.cli(["agenda"]); s.note("buffer", "zarg agenda", r.out) }) })`)
  const e = evidence(root, "S-0001")
  expect(e).toMatchObject({ scenario: "S-0001", journey: "J-0001", passed: true, flaky: false, failure: null })
  expect(e.version).toMatch(/^[0-9a-f]{12}$/)
  expect(e.media).toEqual([{ kind: "buffer", path: "media/S-0001/note-1.txt", caption: "zarg agenda" }])
  expect(readFileSync(join(root, ".zarg", "evidence", "media", "S-0001", "note-1.txt"), "utf8")).toStartWith("[")
}, 60_000)

test("a step that throws before anything still writes passed: false with the error", () => {
  const root = repo()
  runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0002", async () => { throw new Error("expected the agenda") }) })`)
  expect(evidence(root, "S-0002")).toMatchObject({ passed: false, failure: { expected: "expected the agenda" } })
}, 60_000)

test("a model step that passes on its retry is flaky; one naming another journey's scenario is refused", () => {
  const root = repo()
  runJourney(root, `let n = 0
journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0001", async () => { if (n++ === 0) throw new Error("bad answer") }, { model: true }) })`)
  expect(evidence(root, "S-0001")).toMatchObject({ passed: true, flaky: true })
  const r = runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0003", async () => {}) })`)
  expect(r.stderr.toString()).toContain("S-0003 is not a scenario of J-0001")
}, 60_000)

test("the same scenario written twice in one run: the last write wins, whole", () => {
  const root = repo()
  runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0001", async () => { throw new Error("first") }); proves("S-0001", async () => {}) })`)
  expect(evidence(root, "S-0001")).toMatchObject({ passed: true, failure: null })
}, 60_000)

test("E2E_TIER=fast skips a full-tier journey (no evidence written)", () => {
  const root = repo()
  runJourney(root, `journey("J-0001", { tier: "full" }, (proves) => { proves("S-0001", async () => {}) })`, { E2E_TIER: "fast" })
  expect(() => evidence(root, "S-0001")).toThrow()
}, 60_000)

test("a world that fails to start: every step still records passed: false with the error", () => {
  const root = repo()
  // "a" is a file, so "a/b" cannot be written.
  runJourney(root, `journey("J-0001", { tier: "fast", seed: { a: "x", "a/b": "y" } }, (proves) => { proves("S-0001", async () => {}) })`)
  expect(evidence(root, "S-0001")).toMatchObject({ passed: false })
  expect(evidence(root, "S-0001").failure.expected).toContain("a/b")
}, 60_000)

test("a step past its deadline records passed: false (timed out), never a late pass", async () => {
  const root = repo()
  runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0001", async () => { await Bun.sleep(3000) }, { timeoutMs: 500 }) })`)
  await Bun.sleep(3500)
  expect(evidence(root, "S-0001")).toMatchObject({ passed: false, failure: { expected: "timed out after 500 ms" } })
}, 60_000)

test("a run killed mid-step leaves the last evidence and its media whole", () => {
  const root = repo()
  runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0001", async (s) => { s.note("log", "a", "from A") }) })`)
  runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0001", async (s) => { s.note("log", "b", "from B"); process.exit(1) }) })`)
  const e = evidence(root, "S-0001")
  expect(e.media[0].caption).toBe("a")
  expect(readFileSync(join(root, ".zarg", "evidence", e.media[0].path), "utf8")).toBe("from A")
}, 60_000)

test("E2E_EVIDENCE_OUT: the graph is read from the root, the evidence goes elsewhere (a pre-push check leaves the tree clean)", () => {
  const root = repo()
  const out = mkdtempSync(join(tmpdir(), "zt-out-"))
  runJourney(root, `journey("J-0001", { tier: "fast" }, (proves) => { proves("S-0001", async () => {}) })`, { E2E_EVIDENCE_OUT: out })
  expect(() => evidence(root, "S-0001")).toThrow()
  expect(evidence(out, "S-0001")).toMatchObject({ passed: true })
}, 60_000)
