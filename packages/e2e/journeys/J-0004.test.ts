import { expect } from "bun:test"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { answerLoads, choresGraph, command, journey, liveModel, quit, type Step, type World } from "../src"

// A tiny project: one module, its test, and its own check. Reconcile is in the config, turned off (S-0058 turns it on).
const BUN = process.execPath
const config = (extra = "") => `[reconcile]\nenabled = false\nquiet_ms = 1500\nverify = ${JSON.stringify(`${BUN} test`)}\n${extra}`
const SEED = {
  "package.json": `${JSON.stringify({ name: "chores", private: true, type: "module", scripts: { test: "bun test" } })}\n`,
  "src/chores.ts": "export const assign = (chores: ReadonlyArray<string>, chore: string) => [...chores, chore]\n",
  "test/chores.test.ts": 'import { expect, test } from "bun:test"\nimport { assign } from "../src/chores"\n\ntest("a chore is assigned", () => {\n  expect(assign([], "dishes")).toEqual(["dishes"])\n})\n',
  "README.md": "# Chores\n\nA family chore tracker: parents assign chores, children see them.\n",
  ".zarg/config.toml": config(),
}

const git = (w: World, ...args: Array<string>) => Bun.spawnSync(["git", ...args], { cwd: w.project, env: w.env }).stdout.toString().trim()
const lines = (w: World, file: string) => (existsSync(join(w.project, file)) ? readFileSync(join(w.project, file), "utf8").trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>) : [])
const passes = (w: World) => lines(w, ".zarg/threads/plan.jsonl").filter((e) => e.type === "RUN_STARTED").length
const findings = (w: World) => (existsSync(join(w.project, ".zarg/reconcile/findings.json")) ? (JSON.parse(readFileSync(join(w.project, ".zarg/reconcile/findings.json"), "utf8")) as Array<{ kind: string; title: string; detail: string }>) : [])
const topics = (w: World) => (existsSync(join(w.project, ".zarg/inbox")) ? readdirSync(join(w.project, ".zarg/inbox")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(w.project, ".zarg/inbox", f), "utf8")) as { kind: string; title: string; state: string; from: { agent?: string } }) : [])
const said = (w: World, thread: string) => lines(w, `.zarg/threads/${thread}.jsonl`).filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => String(e.delta)).join("\n")
/** Waits up to `ms` for `check` to hold, every 2 s. */
const until = async (ms: number, check: () => boolean) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(2_000)
  return check()
}
/** A fresh session with reconcile turned on by hand (the config keeps it off): the notice it gave. */
const turnOn = async (s: Step) => {
  await quit(s.term)
  const t = await s.open()
  await answerLoads(t)
  t.press("esc")
  await Bun.sleep(500)
  await command(t, "/reconcile")
  await t.waitFor(/Reconcile (is on|stays off)/, 30_000)
  return t
}
const call = async (s: Step, tool: string, params: unknown) => {
  const r = await s.cli(["tool", "call", `gherkin/${tool}`, JSON.stringify(params)])
  expect(r.code).toBe(0)
}

journey("J-0004", { tier: "fast", seed: SEED }, (proves) => {
  proves("S-0059", async (s) => {
    // No model at all: /reconcile says why it stays off.
    const t = await turnOn(s)
    s.note("buffer", "screen", t.screen())
    expect(t.screen()).toContain("Reconcile stays off")
    expect(t.screen()).toContain("/models")
  })

  proves(
    "S-0058",
    async (s) => {
      liveModel(s.w)
      await choresGraph(s)
      git(s.w, "add", "-A")
      git(s.w, "commit", "-qm", "chores graph")
      const t = await turnOn(s)
      s.note("buffer", "screen", t.screen())
      expect(t.screen()).toContain("Reconcile is on")
      // It stays on: the config the operator turned it on in is unchanged (its section says enabled = false), and the pass runs.
      expect(await until(60_000, () => passes(s.w) >= 1)).toBe(true)
    },
    { model: true },
  )

  proves(
    "S-0056",
    async (s) => {
      // The pass lands: each changed scenario's plan is in its commit.
      const landed = await until(900_000, () => git(s.w, "log", "-1", "--format=%s").startsWith("feat: implement"))
      s.note("log", "implement thread", said(s.w, "implement"))
      expect(landed).toBe(true)
      const files = git(s.w, "show", "--name-only", "--format=", "HEAD").split("\n")
      s.note("buffer", "the landed commit", files.join("\n"))
      expect(files).toEqual(expect.arrayContaining([".zarg/plans/S-0001.md", ".zarg/plans/S-0002.md"]))
    },
    { model: true, timeoutMs: 950_000 },
  )

  proves(
    "S-0021",
    async (s) => {
      // The code changed in the commit, tagged with the scenarios it builds.
      const code = git(s.w, "show", "--format=", "HEAD", "--", "src", "test")
      s.note("buffer", "the code it wrote", code)
      expect(code).toMatch(new RegExp(`${"@"}scenario S-000[12]`))
    },
    { model: true },
  )

  proves(
    "S-0022",
    async (s) => {
      // Every check passes on what landed: the project's own test.
      const p = Bun.spawnSync([BUN, "test"], { cwd: s.w.project, env: s.w.env })
      s.note("log", "bun test", p.stdout.toString() + p.stderr.toString())
      expect(p.exitCode).toBe(0)
      expect(findings(s.w).filter((f) => f.kind === "verify-failing")).toEqual([])
    },
    { model: true },
  )

  proves(
    "S-0049",
    async (s) => {
      const log = git(s.w, "log", "--format=%s")
      s.note("buffer", "git log", log)
      expect(log.split("\n")[0]).toMatch(/^feat: implement S-0001, S-0002/)
      expect(git(s.w, "symbolic-ref", "--short", "HEAD")).not.toBe("")
      // Nothing of the pass is left uncommitted in the operator's checkout.
      expect(git(s.w, "status", "--porcelain", "--", "src", "test", ".zarg/graph", ".zarg/plans")).toBe("")
    },
    { model: true },
  )

  proves(
    "S-0020",
    async (s) => {
      // A graph change, then quiet: a new pass picks it up.
      const before = passes(s.w)
      await call(s, "edit-scenario", { id: "S-0002", when: "the parent removes a finished chore" })
      expect(await until(120_000, () => passes(s.w) > before)).toBe(true)
      const landed = await until(900_000, () => git(s.w, "log", "-1", "--format=%s") === "feat: implement S-0002")
      s.note("log", "plan thread", said(s.w, "plan"))
      expect(landed).toBe(true)
    },
    { model: true, timeoutMs: 950_000 },
  )

  proves(
    "S-0050",
    async (s) => {
      // Landing tries twice, three seconds apart; the operator's own edits in the module and its test hold it.
      writeFileSync(join(s.w.project, ".zarg/config.toml"), `${config("land_retry_ms = 3000\nland_attempts = 2\n")}${readFileSync(join(s.w.project, ".zarg/config.toml"), "utf8").replace(/^\[reconcile\][\s\S]*?(?=\n\[|$)/, "")}`)
      git(s.w, "commit", "-qam", "land quickly")
      const t = await turnOn(s)
      await call(s, "edit-scenario", { id: "S-0001", when: "the parent assigns a chore to one child" })
      for (const f of ["src/chores.ts", "test/chores.test.ts"]) writeFileSync(join(s.w.project, f), `${readFileSync(join(s.w.project, f), "utf8")}// mine\n`)
      const waited = await until(900_000, () => said(s.w, "implement").includes("Landing waits on your uncommitted edits"))
      s.note("log", "implement thread", said(s.w, "implement"))
      s.note("buffer", "screen", t.screen())
      expect(waited).toBe(true)
    },
    { model: true, timeoutMs: 950_000 },
  )

  proves(
    "S-0051",
    async (s) => {
      const blocked = await until(120_000, () => findings(s.w).some((f) => f.kind === "landing-blocked"))
      s.note("buffer", "findings", JSON.stringify(findings(s.w), null, 2))
      expect(blocked).toBe(true)
      // The operator's edits are still theirs.
      expect(readFileSync(join(s.w.project, "src/chores.ts"), "utf8")).toContain("// mine")
      git(s.w, "checkout", "--", "src", "test")
    },
    { model: true },
  )

  proves(
    "S-0023",
    async (s) => {
      // A check that can never pass: verify fails, and the Implementer works on it again (a fix).
      writeFileSync(join(s.w.project, ".zarg/config.toml"), readFileSync(join(s.w.project, ".zarg/config.toml"), "utf8").replace(/^verify = .*$/m, 'verify = "exit 1"'))
      git(s.w, "commit", "-qam", "a check that fails")
      await turnOn(s)
      await call(s, "edit-scenario", { id: "S-0002", when: "the parent removes a chore nobody finished" })
      const fixing = await until(900_000, () => lines(s.w, ".zarg/threads/implement.jsonl").some((e) => JSON.stringify(e).includes('"fix-1')))
      s.note("log", "implement thread", said(s.w, "implement"))
      expect(fixing).toBe(true)
    },
    { model: true, timeoutMs: 950_000 },
  )

  proves(
    "S-0055",
    async (s) => {
      const failing = await until(900_000, () => findings(s.w).some((f) => f.kind === "verify-failing"))
      s.note("buffer", "findings", JSON.stringify(findings(s.w), null, 2))
      expect(failing).toBe(true)
      // The finding reaches the operator's inbox.
      expect(await until(30_000, () => topics(s.w).some((t) => t.kind === "finding" && t.title.includes("verify still fails")))).toBe(true)
    },
    { model: true, timeoutMs: 950_000 },
  )

  proves(
    "S-0025",
    async (s) => {
      // The Driver Agent takes up the finding first: its item is the finding, and it asks.
      const rlm = () => lines(s.w, ".zarg/threads/main.rlm.jsonl").filter((e) => e.type === "start").map((e) => String(e.task))
      const taken = await until(300_000, () => rlm().some((task) => task.includes("verify still fails")))
      s.note("log", "the driver's items", rlm().join("\n---\n"))
      expect(taken).toBe(true)
      const asked = await until(300_000, () => topics(s.w).some((t) => t.from.agent === "zarg" && t.kind === "question" && t.state === "open"))
      expect(asked).toBe(true)
    },
    { model: true, timeoutMs: 650_000 },
  )
})
