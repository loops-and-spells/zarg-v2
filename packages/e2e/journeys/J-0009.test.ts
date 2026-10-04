import { expect } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { choresGraph, journey, MAIN, seed, type Step } from "../src"

const SRC = join(import.meta.dir, "..", "src")
/** The world's code, tagged with the scenarios it builds. */
const code = (s: Step, tags: ReadonlyArray<string>, body = "") => {
  mkdirSync(join(s.w.project, "src"), { recursive: true })
  writeFileSync(join(s.w.project, "src", "chores.ts"), `${tags.map((id) => `// ${"@"}scenario ${id}\n`).join("")}export const assign = (chores: string[], chore: string) => [...chores, chore]\n${body}`)
}
const commit = (s: Step, message: string) => {
  Bun.spawnSync(["git", "add", "-A"], { cwd: s.w.project, env: s.w.env })
  Bun.spawnSync(["git", "commit", "-qm", message], { cwd: s.w.project, env: s.w.env })
}
const evidence = (s: Step, id: string) => JSON.parse(readFileSync(join(s.w.project, ".zarg", "evidence", `${id}.json`), "utf8"))
/** Each built scenario's proof, as `zarg audit --json` says. */
const proofOf = async (s: Step, id: string) => ((await s.cli(["audit", "--json"])).json as { readonly proofs: ReadonlyArray<{ readonly scenario: string; readonly proof: string }> }).proofs.find((p) => p.scenario === id)?.proof

journey("J-0009", { tier: "fast" }, (proves) => {
  proves("S-0113", async (s) => {
    await choresGraph(s)
    // S-0002 is built, but no code says so yet.
    code(s, ["S-0001"])
    commit(s, "chores")
    const red = await s.cli(["audit", "--summary"])
    s.note("buffer", "zarg audit --summary (S-0002 untagged)", red.out + red.err)
    expect(red.code).toBe(1)
    expect(red.out).toMatch(/code\s+S-0002/)
    code(s, ["S-0001", "S-0002"])
    commit(s, "tag S-0002")
    const green = await s.cli(["audit", "--summary"])
    s.note("buffer", "zarg audit --summary (both tagged)", green.out + green.err)
    // Only warnings left (nothing proven yet): the audit passes.
    expect(green.code).toBe(0)
    expect(green.out).toMatch(/structure 0 · lints 0 · code 0/)
  })

  proves("S-0114", async (s) => {
    // A journey of the world's own graph, on zarg's e2e harness: one step that passes, one that fails.
    mkdirSync(join(s.w.project, "e2e"), { recursive: true })
    writeFileSync(
      join(s.w.project, "e2e", "J-0001.test.ts"),
      `import { expect } from "bun:test"
import { journey } from ${JSON.stringify(SRC)}
journey("J-0001", { tier: "fast" }, (proves) => {
  proves("S-0001", async (s) => {
    const t = await s.open()
    await t.waitFor("not set up", 30_000)
    s.note("buffer", "where the step ran", s.w.project)
  })
  proves("S-0002", async (s) => {
    expect(s.term!.screen()).toContain("the chore leaves every list")
  })
})
`,
    )
    commit(s, "a journey")
    const p = Bun.spawnSync([process.execPath, "test", join(s.w.project, "e2e", "J-0001.test.ts")], { cwd: s.w.project, env: { ...s.w.env, E2E_EVIDENCE_ROOT: s.w.project, E2E_KEEP_FAILED: "0", E2E_RUN: "e2e-world" } })
    s.note("log", "bun test e2e/J-0001.test.ts", p.stderr.toString().replace(/\x1b\[[0-9;]*m/g, ""))
    // The step ran on a fresh project of its own, never this one.
    const ran = readFileSync(join(s.w.project, ".zarg", "evidence", evidence(s, "S-0001").media.find((m: { kind: string }) => m.kind === "evidence-terminal/text").path), "utf8")
    expect(ran).not.toBe(s.w.project)
    expect(ran).toContain("zarg-e2e-")
  })

  proves("S-0115", async (s) => {
    const e = evidence(s, "S-0001")
    s.note("buffer", ".zarg/evidence/S-0001.json", JSON.stringify(e, null, 2))
    expect(e).toMatchObject({ scenario: "S-0001", journey: "J-0001", passed: true, run: "e2e-world" })
    expect(e.media.map((m: { kind: string }) => m.kind)).toEqual(expect.arrayContaining(["evidence-terminal/frame", "evidence-terminal/cast"]))
  })

  proves("S-0116", async (s) => {
    const e = evidence(s, "S-0002")
    s.note("buffer", ".zarg/evidence/S-0002.json (its failure)", JSON.stringify(e.failure, null, 2))
    expect(e.passed).toBe(false)
    expect(e.failure.expected).toContain("the chore leaves every list")
    expect(e.failure.saw).toContain("not set up")
    expect(await proofOf(s, "S-0002")).toBe("failing")
  })

  proves("S-0117", async (s) => {
    code(s, ["S-0001", "S-0002"], "export const later = 1\n")
    commit(s, "change the code")
    expect(await proofOf(s, "S-0001")).toBe("stale")
    const summary = await s.cli(["audit", "--summary"])
    s.note("buffer", "zarg audit --summary", summary.out)
    expect(summary.out).toMatch(/proof\s+S-0001 stale/)
  })

  proves("S-0118", async (s) => {
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    const served = Bun.spawn([process.execPath, MAIN, "catalog", "--port", String(port)], { cwd: s.w.project, env: s.w.env, stdout: "pipe", stderr: "pipe" })
    try {
      let home = ""
      for (const until = Date.now() + 30_000; Date.now() < until && home === ""; await Bun.sleep(300)) home = await fetch(`http://127.0.0.1:${port}/`).then((r) => (r.ok ? r.text() : ""), () => "")
      s.note("buffer", "GET / (the catalog's home)", home.replace(/<style[\s\S]*?<\/style>/g, "").slice(0, 6000))
      // The verdict, then one tick per scenario, failing first.
      expect(home).toContain('<h1 class="verdict">1 scenario failing.</h1>')
      expect(home.indexOf('class="tick s-failing"')).toBeGreaterThan(-1)
      expect(home.indexOf('class="tick s-failing"')).toBeLessThan(home.indexOf('class="tick s-stale"'))
    } finally {
      served.kill()
      await served.exited
    }
  })

  proves("S-0119", async (s) => {
    const out = join(s.w.home, "catalog")
    expect((await s.cli(["catalog", "build", "--out", out])).code).toBe(0)
    const page = readFileSync(join(out, "scenarios", "S-0001.html"), "utf8")
    // The frames as pictures, the cast in its player.
    expect(page).toContain('class="evidence-frame')
    expect(page).toContain("<svg")
    expect(page).toContain('class="evidence-cast')
    expect(page).toContain("asciinema-player.min.js")
  })

  proves("S-0120", async (s) => {
    const e = evidence(s, "S-0002")
    const files = seed.evidence({ ...e, media: [...e.media, { kind: "evidence-x/y", path: "media/S-0002/9-y.txt", caption: "a medium of another plugin" }] }, { "media/S-0002/9-y.txt": "x" })
    for (const [p, t] of Object.entries(files)) writeFileSync(join(s.w.project, p), t)
    commit(s, "evidence of another plugin's kind")
    const out = join(s.w.home, "catalog-x")
    expect((await s.cli(["catalog", "build", "--out", out])).code).toBe(0)
    const page = readFileSync(join(out, "scenarios", "S-0002.html"), "utf8")
    const card = /<figure class="medium fallback">[\s\S]*?<\/figure>/.exec(page)?.[0] ?? ""
    s.note("buffer", "the fallback card", card)
    expect(card).toContain("evidence-x")
  })
})
