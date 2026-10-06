import { expect } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
const topics = (w: World) => (existsSync(join(w.project, ".zarg/inbox")) ? readdirSync(join(w.project, ".zarg/inbox")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(w.project, ".zarg/inbox", f), "utf8")) as { id: string; kind: string; title: string; state: string; from: { agent?: string } }) : [])
const said = (w: World, thread: string) => lines(w, `.zarg/threads/${thread}.jsonl`).filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => String(e.delta)).join("\n")
/** Waits up to `ms` for `check` to hold, every 2 s. */
const until = async (ms: number, check: () => boolean) => {
  const end = Date.now() + ms
  // True as soon as it holds: checked again after, a finding a new pass clears and raises again could be between the two.
  while (Date.now() < end) {
    if (check()) return true
    await Bun.sleep(2_000)
  }
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
      // The scenarios that landed (one that failed stays pending for the next pass).
      expect(log.split("\n")[0]).toMatch(/^feat: implement S-000[12]/)
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
      // The operator's own edit in S-0001's plan: the pass rewrites it, whatever code it touches.
      for (const f of [".zarg/plans/S-0001.md", "src/chores.ts"]) writeFileSync(join(s.w.project, f), `${readFileSync(join(s.w.project, f), "utf8")}\n<!-- mine -->\n`)
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
      expect(readFileSync(join(s.w.project, ".zarg/plans/S-0001.md"), "utf8")).toContain("<!-- mine -->")
      git(s.w, "checkout", "--", "src", "test", ".zarg/plans")
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

})

// Reconcile's edge cases on scripted models (the core's stub mode): each RLM follows the cells of the route its task names.
const SECRET = "zt-e2e-reconcile-hush-5521"
const PLAN = 'return yield* Rlm.done({ value: { plan: "## Approach\\nWrite it.\\n## Files\\n- src — it\\n## Tests\\n- the project test — it\\n## Depends on\\nnone" } })'
const done = (files: ReadonlyArray<string>) => `return yield* Rlm.done({ value: { files: ${JSON.stringify(files)}, summary: "written" } })`
const write = (path: string, content: string) => `yield* Fs.write({ path: ${JSON.stringify(path)}, content: ${JSON.stringify(content)} })`
// A stub implementer tags what it writes, as a real one must (a pass counts a scenario built only by its tagged code).
const implement = (id: string, path: string, content: string, before = "") => ({ when: `Implement scenario ${id} by`, cells: [`${before}${write(path, `// ${"@"}scenario ${id}\n${content}`)}\n${done([path])}`] })
const STUB_FILE = join(mkdtempSync(join(tmpdir(), "zarg-e2e-stub-")), "cells.json")
writeFileSync(
  STUB_FILE,
  JSON.stringify({
    // zarg itself (findings on its agenda): it notes them and waits.
    cells: ['return yield* Rlm.done({ value: "Noted." })'],
    routes: [
      // zarg takes up the finding S-0002 left: it asks the operator what to do.
      { when: "S-0002 cannot be planned", cells: ['const a = yield* Inquire.ask({ question: "S-0002 cannot be planned: reword it, or drop it?", options: [{ id: "reword", label: "Reword S-0002", recommended: true }, { id: "drop", label: "Drop S-0002" }] })\nyield* Rlm.done({ value: String(a.choice) })'] },
      { when: "implementation plan for scenario S-0001:", cells: [PLAN] },
      // Pass 1: S-0002 cannot be planned; pass 2: it can, then cannot be implemented.
      { when: "implementation plan for scenario S-0002:", cells: ['return yield* Rlm.done({ value: { blocked: "S-0002 contradicts S-0001: a chore cannot leave every list while it stays assigned" } })', PLAN] },
      { when: "implementation plan for scenario", cells: [PLAN] },
      // S-0001 runs a command first: its environment, with the project's secret in the core's.
      { when: "Implement scenario S-0001 by", cells: ['const r = yield* Sh.run({ command: "env" })\nreturn r', `${write("src/assign.ts", `// ${"@"}scenario S-0001\nexport const assignTo = (child: string) => child\n`)}\n${done(["src/assign.ts"])}`] },
      { when: "Implement scenario S-0002 by", cells: ['return yield* Rlm.done({ value: { files: [], summary: "", blocked: "S-0002 contradicts S-0001: removing leaves the chore assigned" } })'] },
      // Two scenarios adding the same file: an obvious conflict (resolved), then one beyond an obvious fix (not).
      implement("S-0003", "src/shared.ts", "export const three = 3\n"),
      implement("S-0004", "src/shared.ts", "export const four = 4\n"),
      implement("S-0005", "src/other.ts", "export const five = 5\n"),
      implement("S-0006", "src/other.ts", "export const five = 6\n"),
      { when: "These files have merge conflicts", cells: [`${write("src/shared.ts", "export const three = 3\nexport const four = 4\n")}\nreturn yield* Rlm.done({ value: { resolved: true } })`, "return yield* Rlm.done({ value: { resolved: false } })"] },
      // S-0007 takes a while: the operator commits meanwhile.
      implement("S-0007", "src/seven.ts", "export const seven = 7\n", 'yield* Effect.sleep("15 seconds")\n'),
    ],
  }),
)
const rlmLog = (w: World, thread: string) => lines(w, `.zarg/threads/${thread}.rlm.jsonl`)
const cellsOf = (w: World, thread: string) => rlmLog(w, thread).flatMap((e) => (e.type === "step" ? ((e.cells ?? []) as Array<{ code: string; ok: boolean; output: string }>) : []))
const tasksOf = (w: World, thread: string) => rlmLog(w, thread).filter((e) => e.type === "start").map((e) => String(e.task))
const scenario = (s: Step, n: number, path: string) =>
  call(s, "add-scenario", { title: `Parent sorts chores ${n}`, when: `the parent sorts the chores by ${path}`, by: [{ name: "Parent" }], arrives: { id: "ST-0001" }, then: [{ text: `the chores are sorted by ${path}` }] })

journey(
  "J-0004",
  {
    tier: "fast",
    seed: { ...SEED, ".env.schema": "# @defaultSensitive=false\n# ---\n# A key no command may see.\n# @sensitive\nZT_E2E_RECONCILE_SECRET=\n", ".env.local": `ZT_E2E_RECONCILE_SECRET=${SECRET}\n` },
    env: { ZARG_CORE_STUB: STUB_FILE },
  },
  (proves) => {
    proves("S-0047", async (s) => {
      await choresGraph(s)
      git(s.w, "add", "-A")
      git(s.w, "commit", "-qm", "chores graph")
      await turnOn(s)
      expect(await until(120_000, () => cellsOf(s.w, "implement").some((c) => c.code.includes('Sh.run({ command: "env" })')))).toBe(true)
      const env = cellsOf(s.w, "implement").find((c) => c.code.includes('Sh.run({ command: "env" })'))!
      s.note("buffer", "env, as the implementer's command saw it", env.output)
      expect(env.ok).toBe(true)
      expect(env.output).toContain("PATH")
      expect(env.output).not.toContain("ZT_E2E_RECONCILE_SECRET")
      expect(env.output).not.toContain(SECRET)
    })

    proves("S-0057", async (s) => {
      expect(await until(120_000, () => git(s.w, "log", "-1", "--format=%s").startsWith("feat: implement"))).toBe(true)
      const f = findings(s.w).find((x) => x.kind === "unplannable")
      s.note("buffer", "the finding", JSON.stringify(f, null, 2))
      expect(f?.title).toBe("S-0002 cannot be planned")
      expect(f?.detail).toContain("contradicts S-0001")
      // On zarg's agenda: its inbox shows the finding.
      expect(await until(30_000, () => topics(s.w).some((t) => t.kind === "finding" && t.title.includes("S-0002 cannot be planned")))).toBe(true)
    })

    // @scenario S-0025
    proves("S-0025", async (s) => {
      // zarg takes the finding up as its next item, and asks the operator about it.
      expect(await until(60_000, () => tasksOf(s.w, "main").some((t) => t.includes("S-0002 cannot be planned")))).toBe(true)
      expect(await until(60_000, () => topics(s.w).some((t) => t.from.agent === "zarg" && t.kind === "question" && t.state === "open" && t.title.includes("S-0002 cannot be planned")))).toBe(true)
      s.note("buffer", "zarg's item", tasksOf(s.w, "main").find((t) => t.includes("S-0002 cannot be planned")) ?? "")
    })

    proves("S-0024", async (s) => {
      // A new pass: S-0002 (pending) plans now, then cannot be implemented; S-0003 and S-0004 come with it.
      await scenario(s, 3, "name")
      await scenario(s, 4, "date")
      const head = git(s.w, "rev-parse", "HEAD")
      expect(await until(180_000, () => git(s.w, "rev-parse", "HEAD") !== head && findings(s.w).some((x) => x.kind === "blocked-scenario"))).toBe(true)
      const f = findings(s.w).find((x) => x.kind === "blocked-scenario")!
      s.note("buffer", "the finding", JSON.stringify(f, null, 2))
      expect(f.title).toBe("S-0002 cannot be implemented as written")
      expect(await until(30_000, () => topics(s.w).some((t) => t.kind === "finding" && t.title.includes("S-0002 cannot be implemented")))).toBe(true)
    }, { timeoutMs: 300_000 })

    proves("S-0122", async (s) => {
      // The passes so far showed among the operator's agents: a build row naming what each planned or implemented, then how it ended.
      const build = () => lines(s.w, ".zarg/threads/main.jsonl").filter((e) => e.type === "ACTIVITY_DELTA" && e.messageId === "main-build").flatMap((e) => (e.patch as Array<{ value?: { status?: string; row?: { text?: string } } }>).map((p) => p.value))
      const texts = build().map((v) => `${v?.status}: ${v?.row?.text}`)
      s.note("buffer", "the build row, as it changed", texts.join("\n"))
      s.note("buffer", "screen", s.term?.screen() ?? "")
      expect(texts.some((t) => /^running: .*(plan|implement) S-000\d/.test(t))).toBe(true)
      expect(texts.some((t) => /^(done|failed): /.test(t))).toBe(true)
      // Opened, the row has a view: what the pass does now and what it did.
      const view = lines(s.w, ".zarg/threads/main.jsonl").filter((e) => String(e.messageId) === "main:view:build")
      s.note("buffer", "the build row's view", JSON.stringify(view.slice(-3), null, 2))
      expect(view.some((e) => e.type === "ACTIVITY_SNAPSHOT")).toBe(true)
      expect(JSON.stringify(view)).toMatch(/plan S-000\d|implement S-000\d/)
      expect(s.term?.screen() ?? "").toContain("build")
      expect(s.term?.screen() ?? "").not.toContain("build build")
    })

    proves("S-0053", async (s) => {
      // S-0003 and S-0004 both added src/shared.ts: the resolver kept both sides, verify ran, the pass landed.
      expect(tasksOf(s.w, "implement").some((t) => t.includes("These files have merge conflicts"))).toBe(true)
      const log = git(s.w, "log", "-1", "--format=%s")
      s.note("buffer", "git log -1", log)
      expect(log).toContain("S-0003")
      expect(log).toContain("S-0004")
      const shared = readFileSync(join(s.w.project, "src/shared.ts"), "utf8")
      s.note("buffer", "src/shared.ts", shared)
      expect(shared).toBe("export const three = 3\nexport const four = 4\n")
    })

    proves("S-0054", async (s) => {
      await scenario(s, 5, "size")
      await scenario(s, 6, "colour")
      // The finding is in zarg's inbox (the next pass builds that scenario alone, and the finding clears).
      const raised = () => topics(s.w).find((t) => t.kind === "finding" && /S-000[56] conflicts with other scenarios in this pass/.test(t.title))
      expect(await until(180_000, () => raised() !== undefined)).toBe(true)
      s.note("buffer", "the finding", JSON.stringify(raised(), null, 2))
      expect(tasksOf(s.w, "implement").filter((t) => t.includes("These files have merge conflicts")).length).toBeGreaterThanOrEqual(2)
    }, { timeoutMs: 300_000 })

    proves("S-0052", async (s) => {
      // Wait for the last pass to settle, then S-0007: it takes a while, and the operator commits meanwhile.
      await until(120_000, () => !tasksOf(s.w, "implement").some((t) => t.includes("Implement scenario S-0007")) && passes(s.w) >= 3)
      await scenario(s, 7, "owner")
      expect(await until(120_000, () => tasksOf(s.w, "implement").some((t) => t.includes("Implement scenario S-0007")))).toBe(true)
      writeFileSync(join(s.w.project, "NOTES.md"), "The operator's own note.\n")
      git(s.w, "add", "NOTES.md")
      git(s.w, "commit", "-qm", "the operator's commit")
      const mine = git(s.w, "rev-parse", "HEAD")
      expect(await until(180_000, () => git(s.w, "log", "-1", "--format=%s").includes("S-0007"))).toBe(true)
      const log = git(s.w, "log", "-3", "--format=%h %s")
      s.note("buffer", "git log", log)
      // The pass landed on top of the operator's commit, after verify ran again there.
      expect(git(s.w, "rev-parse", "HEAD~1")).toBe(mine)
      expect(lines(s.w, ".zarg/threads/implement.jsonl").length).toBeGreaterThan(0)
    }, { timeoutMs: 400_000 })

    proves("S-0123", async (s) => {
      // S-0003 landed long ago and nothing changed it: the operator asks for it again, and a pass builds it.
      const before = tasksOf(s.w, "implement").filter((t) => t.includes("Implement scenario S-0003")).length
      await command(s.term!, "/reconcile S-0003")
      await s.term!.waitFor(/building S-0003 again/, 30_000)
      s.note("buffer", "screen", s.term!.screen())
      expect(await until(180_000, () => tasksOf(s.w, "implement").filter((t) => t.includes("Implement scenario S-0003")).length > before)).toBe(true)
      expect(await until(180_000, () => git(s.w, "log", "-1", "--format=%s") === "feat: implement S-0003")).toBe(true)
      s.note("buffer", "git log", git(s.w, "log", "-3", "--format=%h %s"))
    }, { timeoutMs: 400_000 })
  },
)
