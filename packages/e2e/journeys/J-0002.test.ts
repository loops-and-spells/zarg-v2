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
    // Not now, for each question, then the Setup sheet closes: wait until neither shows, and the screen has settled.
    const until = Date.now() + 30_000
    for (let quiet = 0; quiet < 3 && Date.now() < until; ) {
      await Bun.sleep(400)
      const screen = t.screen()
      if (screen.includes("Not now")) {
        quiet = 0
        // Pick "Not now" by its label, whatever is selected.
        for (let k = 0; k < 3 && !/›\s*Not now/.test(t.screen()); k++) {
          t.press("right")
          await Bun.sleep(100)
        }
        t.press("enter")
      } else if (screen.includes("esc closes")) {
        quiet = 0
        // An answered question gives the bar its keys first; Esc until the sheet is gone.
        t.press("esc")
      } else quiet++
    }
    expect(t.screen()).not.toContain("Not now")
    expect(t.screen()).not.toContain("esc closes")
    await t.waitFor("Nothing needs you", 10_000)
  })

  proves("S-0067", async (s) => {
    const t = s.term
    if (t === undefined) throw new Error("S-0067 runs in the TUI S-0069 opened, and S-0069 did not open it")
    // One burst, as the operator types it.
    t.type("/yolo on")
    await t.waitFor("/yolo on", 5_000)
    t.press("enter")
    await t.waitFor(/·\s*YOLO\s*·/, 10_000)
    // The status line says so (its notice, "YOLO is on…", is cut to the width).
    expect(t.screen().split("\n").at(-1)).toMatch(/·\s*YOLO\s*·.*YOLO is/)
  })
})
