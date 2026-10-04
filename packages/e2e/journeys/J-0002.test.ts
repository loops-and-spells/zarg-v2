import { expect } from "bun:test"
import { journey } from "../src"

journey("J-0002", { tier: "fast" }, (proves) => {
  proves("S-0069", async (s) => {
    const t = await s.open()
    // First run: the Setup sheet, and over it the grant question of a plugin that reaches past the graph.
    await t.waitFor("not set up", 30_000)
    await t.waitFor("wants to load", 10_000)
    expect(t.screen()).toMatch(/Plugin backlog wants to load/)
    // zarg's own plugins that only touch the graph started approved: they never ask.
    const agenda = (await s.cli(["agenda"])).json as ReadonlyArray<{ readonly id: string }>
    const grants = agenda.map((a) => a.id).filter((id) => id.startsWith("plugin-grant:"))
    s.note("buffer", "zarg agenda (the grants asked for)", grants.join("\n"))
    expect(grants).toContain("plugin-grant:backlog")
    for (const own of ["gherkin", "evidence-terminal", "evidence-screen"]) expect(grants).not.toContain(`plugin-grant:${own}`)
    // Not now, for each question, then the Setup sheet closes: the inbox.
    for (let i = 0; i < 8; i++) {
      // A question can follow the one just answered: settle before looking again.
      await Bun.sleep(800)
      if (!t.screen().includes("Not now")) break
      t.press("right")
      t.press("enter")
    }
    // Esc until the Setup sheet is gone (an answered question gives the bar its keys back first).
    for (let i = 0; i < 4 && t.screen().includes("esc closes"); i++) {
      t.press("esc")
      await Bun.sleep(500)
    }
    expect(t.screen()).not.toContain("esc closes")
    await t.waitFor("Nothing needs you", 10_000)
  })

  proves("S-0067", async (s) => {
    const t = s.term!
    // One burst, as the operator types it.
    t.type("/yolo on")
    await t.waitFor("/yolo on", 5_000)
    t.press("enter")
    await t.waitFor(/·\s*YOLO\s*·/, 10_000)
    // The status line says so (its notice, "YOLO is on…", is cut to the width).
    expect(t.screen().split("\n").at(-1)).toMatch(/·\s*YOLO\s*·.*YOLO is/)
  })
})
