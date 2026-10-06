import { expect } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { journey, type Step } from "../src"

// Built from parts, so this file holds no tag of its own.
const TAG = "@" + "scenario"

/** `zarg <args>`, its transcript kept as the step's evidence. */
const zarg = async (s: Step, ...args: Array<string>) => {
  const r = await s.cli(args)
  s.note("buffer", `zarg ${args.join(" ")}`, `$ zarg ${args.join(" ")}\n${r.out}${r.err}`)
  return r
}
const call = (s: Step, tool: string, params: unknown) => zarg(s, "tool", "call", tool, JSON.stringify(params))
const git = (s: Step, ...args: Array<string>) => {
  const p = Bun.spawnSync(["git", ...args], { cwd: s.w.project, env: s.w.env })
  s.note("log", `git ${args.join(" ")}`, `$ git ${args.join(" ")}\n${p.stdout.toString()}${p.stderr.toString()}`)
  return p.stdout.toString()
}

journey("J-0005", { tier: "fast" }, (proves) => {
  proves("S-0001", async (s) => {
    const r = await zarg(s, "agenda")
    expect(r.code).toBe(0)
    const items = r.json as ReadonlyArray<{ priority: number }>
    expect(items.length).toBeGreaterThan(0)
    expect(items.map((i) => i.priority)).toEqual([...items.map((i) => i.priority)].sort((a, b) => a - b))
  })

  proves("S-0002", async (s) => {
    expect((await call(s, "gherkin/add-persona", { name: "CLI actor", kind: "cli", text: "A coding agent working through the zarg CLI." })).code).toBe(0)
    const r = await call(s, "gherkin/add-scenario", { title: "CLI actor opens pricing", when: "the CLI actor opens pricing", by: [{ name: "CLI actor" }], arrives: { text: "the home page is shown" }, then: [{ text: "the plans are shown" }] })
    expect(r.code).toBe(0)
    expect(existsSync(join(s.w.project, ".zarg", "graph", "nodes", "S-0001.json"))).toBe(true)
    const shown = (await zarg(s, "render", "--focus", "S-0001")).out
    expect(shown).toContain("Given the home page is shown  # ST-0001")
    expect(shown).toContain("Then  the plans are shown  # ST-0002")
  })

  proves("S-0003", async (s) => {
    const r = await call(s, "gherkin/add-scenario", { title: "CLI actor buys a plan", when: "the CLI actor buys if the card is valid", by: [{ name: "CLI actor" }], arrives: { id: "ST-0002" }, then: [{ text: "the receipt is shown" }] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('"conditional"')
    expect(r.err).toContain("make one scenario per case instead")
    expect(existsSync(join(s.w.project, ".zarg", "graph", "nodes", "S-0002.json"))).toBe(false)
  })

  proves("S-0006", async (s) => {
    const r = await call(s, "gherkin/add-scenario", { title: "CLI actor buys a plan", when: "the CLI actor buys with a valid card", by: [{ name: "CLI actor" }], arrives: { id: "ST-0002" }, then: [{ text: "the receipt is shown" }] })
    expect(r.code).toBe(0)
    expect(existsSync(join(s.w.project, ".zarg", "graph", "nodes", "S-0002.json"))).toBe(true)
  })

  proves("S-0004", async (s) => {
    // ST-0002 is S-0001's Then and S-0002's Given.
    expect((await call(s, "gherkin/edit-state", { id: "ST-0002", text: "the plan picker is shown" })).code).toBe(0)
    const shown = (await zarg(s, "render")).out
    expect(shown).toContain("Then  the plan picker is shown  # ST-0002")
    expect(shown).toContain("Given the plan picker is shown  # ST-0002")
    expect(shown).not.toContain("the plans are shown")
  })

  proves("S-0007", async (s) => {
    // A scenario naming the same Then twice: the lint says how to fix it.
    const twice = await call(s, "gherkin/add-scenario", { title: "CLI actor closes pricing", when: "the CLI actor closes pricing", by: [{ name: "CLI actor" }], arrives: { id: "ST-0002" }, then: [{ id: "ST-0001" }, { id: "ST-0001" }] })
    expect(twice.code).toBe(1)
    expect(twice.err).toContain("twice; remove the duplicate")
    // Linking an edge a scenario already has: nothing changes, and it says so (the graph never holds it twice).
    const again = await call(s, "gherkin/link", { scenario: "S-0001", edge: "then", state: { id: "ST-0002" } })
    expect(again.code).toBe(0)
    expect(again.out).toContain("S-0001 already has then ST-0002: no change")
  })

  proves("S-0005", async (s) => {
    const r = await zarg(s, "diff", "--since", "HEAD")
    expect(r.code).toBe(0)
    const added = (r.json as { added: ReadonlyArray<{ id: string }> }).added.map((n) => n.id)
    expect(added).toEqual(expect.arrayContaining(["P-0001", "S-0001", "S-0002", "ST-0001", "ST-0002", "ST-0003"]))
  })

  proves("S-0079", async (s) => {
    const r = await zarg(s, "affected")
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ scenarios: ["S-0001", "S-0002"], removed: [] })
  })

  proves("S-0081", async (s) => {
    mkdirSync(join(s.w.project, "src"), { recursive: true })
    writeFileSync(join(s.w.project, "src", "pricing.ts"), `export const open = () => "plans" // ${TAG} S-0001\n`)
    const r = await zarg(s, "query", "code", "S-0001")
    expect(r.json).toEqual([`src/pricing.ts:1:export const open = () => "plans" // ${TAG} S-0001`])
  })

  proves("S-0082", async (s) => {
    appendFileSync(join(s.w.project, "src", "pricing.ts"), `export const close = () => "home" // ${TAG} S-0001\n`)
    const r = await zarg(s, "query", "code", "S-0001")
    expect((r.json as ReadonlyArray<string>).map((l) => l.split(":").slice(0, 2).join(":"))).toEqual(["src/pricing.ts:1", "src/pricing.ts:2"])
  })

  proves("S-0083", async (s) => {
    expect((await zarg(s, "checkpoint")).code).toBe(0)
    const staged = git(s, "diff", "--cached", "--name-only").split("\n")
    expect(staged).toContain(".zarg/reconciled.json")
    expect(staged).toContain(".zarg/graph/nodes/S-0001.json")
    // The checkpoint counts once committed with the graph.
    git(s, "commit", "-q", "-m", "req: pricing")
    expect((await zarg(s, "affected")).json).toMatchObject({ scenarios: [], removed: [] })
  })

  proves("S-0080", async (s) => {
    // Code changes alone leave the graph in sync.
    appendFileSync(join(s.w.project, "src", "pricing.ts"), "// more code\n")
    expect((await zarg(s, "affected")).json).toMatchObject({ scenarios: [], removed: [] })
  })
})
