import { expect } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { scenarioVersion } from "@zarg/audit/version"
import { Snapshot } from "@zarg/graph/pure"
import { answerLoads, choresGraph, command, journey, liveModel, openNav, quit, seed, termOf, type World } from "../src"

const versionOf = (root: string, id: string) => {
  const dir = join(root, ".zarg", "graph", "nodes")
  return scenarioVersion(Snapshot.make(readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))), id)!
}
const write = (root: string, files: Record<string, string>) => {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), t)
  }
}
/** The JSON files under `.zarg/<dir>`. */
const filesOf = <A>(w: World, dir: string): ReadonlyArray<A> => {
  const d = join(w.project, ".zarg", dir)
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as A) : []
}
const eventually = async <A>(ms: number, check: () => A | undefined): Promise<A | undefined> => {
  const until = Date.now() + ms
  for (;;) {
    const a = check()
    if (a !== undefined || Date.now() > until) return a
    await Bun.sleep(2_000)
  }
}
/** What was filed before the rehearsal: id → how many runs reported it. */
let filedBefore = new Map<string, number>()
const finding = (ref: string, note: string) => ({ ref, journeys: ["Assign chores"], persona: "Parent", kind: "bug", severity: "high" as const, note, from: { agent: "rehearse", run: "r-e2e" }, triage: { on: true, why: "real" } })

journey("J-0008", { tier: "fast" }, (proves) => {
  proves("S-0121", async (s) => {
    await choresGraph(s)
    const v1 = versionOf(s.w.project, "S-0001")
    const v2 = versionOf(s.w.project, "S-0002")
    // What a rehearsal filed, as the backlog keeps it.
    write(s.w.project, seed.feedback([finding(`gherkin/scenario:S-0001@${v1}`, "The child is never told a chore was assigned."), finding(`gherkin/scenario:S-0002@${v2}`, "Removing a chore asks nothing, so a slip deletes it.")]))
    // Two plans that wait in Backlog: one to take, one to drop.
    const ref = (id: string, v: string) => ({ ref: `gherkin/scenario:${id}@${v}` })
    write(s.w.project, seed.plan({ id: "B-01", status: "backlog", title: "Tell the child", journey: "Assign chores", scenarios: [ref("S-0001", v1)], changes: [{ tool: "edit-scenario", params: { id: "S-0001", title: "Parent assigns a chore and the child is told" } }], feedback: [], steps: ["Retitle S-0001"] }))
    write(s.w.project, seed.plan({ id: "B-02", status: "backlog", title: "Confirm removals", journey: "Assign chores", scenarios: [ref("S-0002", v2)], changes: [{ tool: "edit-scenario", params: { id: "S-0002", title: "Parent removes a chore after a confirm" } }], feedback: [], steps: ["Retitle S-0002"] }))
    // And one drafted on a version of S-0002 that is gone: the scenario changed since.
    write(s.w.project, seed.plan({ id: "B-03", status: "backlog", title: "Undo a removal", journey: "Assign chores", scenarios: [ref("S-0002", "000000000000")], changes: [{ tool: "edit-scenario", params: { id: "S-0002", title: "Parent removes a chore and can undo it" } }], feedback: [], steps: ["Retitle S-0002"] }))
    Bun.spawnSync(["git", "add", "-A"], { cwd: s.w.project, env: s.w.env })
    Bun.spawnSync(["git", "commit", "-qm", "the graph, its feedback and plans"], { cwd: s.w.project, env: s.w.env })
    const t = await s.open()
    await answerLoads(t, "backlog")
    t.press("esc")
    await t.waitGone("esc closes", 10_000)
    await openNav(t, "Feedback")
    await t.waitFor("Assign chores · 2 entries · 2 on", 10_000)
    expect(t.screen()).toMatch(/\[●\]◇ S-0001 Parent assigns/)
    expect(t.screen()).toMatch(/\[●\]◇ S-0002 Parent removes/)
  })

  proves("S-0108", async (s) => {
    const t = termOf(s.term, "S-0108")
    // To the entries (] moves through the sections), the highlighted one off.
    for (let k = 0; k < 4 && !t.screen().includes("2 entries · 1 on"); k++) {
      t.press("]")
      await Bun.sleep(300)
      t.press("space")
      await Bun.sleep(700)
    }
    await t.waitFor("2 entries · 1 on", 10_000)
    expect(t.screen()).toMatch(/\[ \]◇ S-0002 Parent removes/)
    s.note("buffer", "screen", t.screen())
  })

  proves("S-0109", async (s) => {
    const t = termOf(s.term, "S-0109")
    t.press("r")
    // In line for a Triage Agent (none runs here: it waits).
    await t.waitFor("Queued for triage: 1 scenario", 10_000)
    expect(t.screen()).toContain("· in triage")
    const dir = join(s.w.project, ".zarg", "triage")
    const stage = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".json"))!), "utf8")) as { journey: string; stage: string; inputs: ReadonlyArray<string> }
    s.note("buffer", ".zarg/triage (the journey's stage)", JSON.stringify(stage, null, 2))
    expect(stage).toMatchObject({ journey: "Assign chores", stage: "refine" })
    // Only the entry that is on: the one turned off stays out (S-0108).
    expect(stage.inputs).toHaveLength(1)
  })

  proves("S-0111", async (s) => {
    const t = termOf(s.term, "S-0111")
    await openNav(t, "Backlog")
    await t.waitFor("B-01 S-0001", 10_000)
    // The plan drafted on an old version says so; the current ones do not.
    // (A lane's card cuts the words: "⚠ scenari…".)
    await t.waitFor("⚠ scenar", 10_000)
    expect(t.screen().match(/⚠ scenar/g)?.length).toBe(1)
    expect(t.screen()).toMatch(/B-03 S-0002[\s\S]*⚠ scenar/)
    // B-01 is the first card: ⇧→ moves it to Ready.
    t.press("shift+right")
    // The Planner applies its change and commits exactly that.
    const until = Date.now() + 30_000
    let title = ""
    while (Date.now() < until && !(title = (await s.cli(["show", "S-0001"])).out).includes("the child is told")) await Bun.sleep(500)
    expect(title).toContain("Parent assigns a chore and the child is told")
    const log = Bun.spawnSync(["git", "log", "-1", "--stat", "--format=%s"], { cwd: s.w.project, env: s.w.env }).stdout.toString()
    s.note("buffer", "git log -1 --stat", log)
    expect(log).toContain("S-0001")
    s.note("buffer", "screen", t.screen())
  })

  proves("S-0112", async (s) => {
    const t = termOf(s.term, "S-0112")
    await t.waitFor("B-02 S-0002", 10_000)
    // B-02 waits in Backlog (the first lane; the cursor followed B-01 on): back to it, open its drawer, then Drop (X).
    for (let i = 0; i < 4; i++) {
      t.press("left")
      await Bun.sleep(150)
    }
    t.press("enter")
    await t.waitFor("B-02 · Backlog", 10_000)
    // The drawer takes the keys (Alt+→), then Drop.
    t.press("alt+right")
    await Bun.sleep(300)
    t.press("X")
    const file = join(s.w.project, ".zarg", "backlog", "B-02.json")
    const until = Date.now() + 10_000
    while (Date.now() < until && JSON.parse(readFileSync(file, "utf8")).dropped !== true) await Bun.sleep(200)
    s.note("buffer", "screen", t.screen())
    const plan = JSON.parse(readFileSync(file, "utf8"))
    s.note("buffer", ".zarg/backlog/B-02.json", JSON.stringify(plan, null, 2))
    expect(plan.dropped).toBe(true)
    // Its scenario was never changed; the board no longer shows it.
    await t.waitGone("B-02 S-0002", 10_000)
    expect((await s.cli(["show", "S-0002"])).out).not.toContain("after a confirm")
  })

  proves(
    "S-0105",
    async (s) => {
      // The live router as the project's model; tagged code for the testers to read.
      liveModel(s.w)
      // The code of S-0002 does not do what its scenario says (the chore stays): something for the testers to find.
      write(s.w.project, { "src/chores.ts": `// @scenario S-0001\nexport const assign = (chores: string[], chore: string) => [...chores, chore]\n// @scenario S-0002\n// Removing only marks the chore as hidden for the parent; every other list still shows it.\nexport const remove = (chores: string[], _chore: string) => chores\n` })
      await quit(s.term)
      // What was filed before this run (S-0106 looks for what it adds).
      filedBefore = new Map(filesOf<{ id: string; runs?: ReadonlyArray<string> }>(s.w, "feedback").map((f) => [f.id, f.runs?.length ?? 1]))
      const t = await s.open()
      // The plugins never approved ask first (YOLO, next, loads them all).
      await answerLoads(t)
      await command(t, "/yolo on")
      // Out of /yolo's line before the next command.
      t.press("esc")
      await Bun.sleep(300)
      await command(t, "/rehearse journey")
      // A run walks the journey with a tester for its one persona (Parent), a story per scenario.
      const run = await eventually(180_000, () =>
        filesOf<{ run: string; personas: ReadonlyArray<{ name: string }>; stories: ReadonlyArray<ReadonlyArray<string>> }>(s.w, "rehearse").find((r) => Array.isArray(r.personas) && r.personas.some((p) => p.name === "Parent") && r.stories.length > 0),
      )
      s.note("buffer", "the rehearse run", JSON.stringify(run ?? null, null, 2).slice(0, 3000))
      expect(run).toBeDefined()
    },
    { model: true },
  )

  proves(
    "S-0106",
    async (s) => {
      // A new entry, or a seeded one the run reported again (same finding, same version: it merges).
      const filed = await eventually(300_000, () => filesOf<{ id: string; ref: string; runs?: ReadonlyArray<string>; from: { agent: string } }>(s.w, "feedback").find((f) => f.from.agent === "rehearse" && (f.runs?.length ?? 1) > (filedBefore.get(f.id) ?? 0)))
      s.note("buffer", "the feedback filed", JSON.stringify(filed ?? null, null, 2))
      expect(filed?.ref).toMatch(/^gherkin\/scenario:S-000[12]@[0-9a-f]{12}$/)
    },
    { model: true, timeoutMs: 330_000 },
  )

  proves(
    "S-0107",
    async (s) => {
      // The code says one thing, the scenario another: remove asks nothing, the feedback said it should.
      const drift = await eventually(300_000, () => filesOf<{ kind: string; ref: string }>(s.w, "feedback").find((f) => f.kind === "drift"))
      const topic = await eventually(60_000, () => filesOf<{ from: { plugin: string }; state: string; title: string }>(s.w, "inbox").find((x) => x.from.plugin === "backlog" && x.state === "open" && /drift|differ/i.test(x.title)))
      s.note("buffer", "the drift and its topic", JSON.stringify({ drift, topic }, null, 2))
      expect(topic).toBeDefined()
    },
    { model: true, timeoutMs: 400_000 },
  )

  proves(
    "S-0110",
    async (s) => {
      // The journey waits in line since S-0109; with YOLO a Triage Agent takes it.
      const plan = await eventually(400_000, () => filesOf<{ id: string; status: string; dropped?: boolean }>(s.w, "backlog").find((p) => p.status === "backlog" && p.dropped !== true && !["B-01", "B-02"].includes(p.id)))
      s.note("buffer", "the plan triage drafted", JSON.stringify(plan ?? null, null, 2))
      expect(plan).toBeDefined()
    },
    { model: true, timeoutMs: 430_000 },
  )
})
