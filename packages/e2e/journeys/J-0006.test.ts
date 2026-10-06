import { expect } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { answerLoads, command, say, journey, liveModel, PROBE, quit, termOf, type Term, type World } from "../src"

/** The inbox's topics as the core keeps them (one file each). */
const topics = (w: World) =>
  readdirSync(join(w.project, ".zarg", "inbox"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(w.project, ".zarg", "inbox", f), "utf8")) as { id: string; title: string; state: string; blocking: boolean; durable?: boolean; from: { plugin: string }; answer?: { id?: string; text?: string }; snoozed?: unknown })
const topic = (w: World, title: string) => topics(w).find((t) => t.title === title)
/** Leaves the message bar: the inbox has the keys. */
const toInbox = async (t: Term) => {
  t.press("esc")
  await t.waitFor("1-9 answer", 5_000)
}
/** The inbox's open rows, top to bottom, by title. */
const rows = (t: Term) => t.screen().split("\n").filter((l) => /[◆◇·]\s+probe\s/.test(l))
/** Moves the inbox's cursor to the row titled `title`. */
const highlight = async (t: Term, title: string) => {
  for (let k = 0; k < 8 && !new RegExp(`▍.*${title}`).test(t.screen()); k++) {
    t.press("down")
    await Bun.sleep(150)
  }
  for (let k = 0; k < 8 && !new RegExp(`▍.*${title}`).test(t.screen()); k++) {
    t.press("up")
    await Bun.sleep(150)
  }
  expect(t.screen()).toMatch(new RegExp(`▍.*${title}`))
}

journey("J-0006", { tier: "fast" }, (proves) => {
  proves("S-0092", async (s) => {
    // A third-party plugin that asks the operator through the inbox, installed and approved.
    expect((await s.cli(["plugin", "build", PROBE])).code).toBe(0)
    expect((await s.cli(["plugin", "add", join(PROBE, "dist")])).code).toBe(0)
    mkdirSync(join(s.w.project, ".zarg"), { recursive: true })
    writeFileSync(join(s.w.project, ".zarg", "config.toml"), `[plugins.probe]\nsource = ${JSON.stringify(join(PROBE, "dist"))}\n`)
    const t = await s.open()
    await answerLoads(t, "probe")
    t.press("esc")
    await t.waitGone("esc closes", 10_000)
    // Three checks it posts, then a question it waits on.
    for (const c of ["a", "b", "c"]) {
      await command(t, `/check ${c}`)
      await t.waitFor(`Check ${c}`, 10_000)
    }
    await command(t, "/block")
    await toInbox(t)
    await t.waitFor("Probe waits for a go", 10_000)
    const open = rows(t)
    s.note("buffer", "the inbox's rows", open.join("\n"))
    expect(open[0]).toContain("Probe waits for a go")
    expect(open.slice(1).every((l) => l.includes("Check"))).toBe(true)
  })

  proves("S-0093", async (s) => {
    const t = termOf(s.term, "S-0093")
    await highlight(t, "Probe waits for a go")
    t.press("1")
    await t.waitGone("Probe waits for a go", 10_000)
    // The plugin that asked had waited on it: it says what it heard.
    await t.waitFor("Gate: go", 10_000)
    expect(topic(s.w, "Probe waits for a go")).toMatchObject({ state: "answered", answer: { id: "go" } })
  })

  proves("S-0094", async (s) => {
    const t = termOf(s.term, "S-0094")
    await highlight(t, "Check a")
    // Open it, pick Drop, then t: a reason to send with it.
    t.press("enter")
    await Bun.sleep(300)
    t.press("down")
    await Bun.sleep(200)
    t.press("t")
    await Bun.sleep(200)
    t.type("too old")
    await t.waitFor("too old", 5_000)
    t.press("enter")
    await t.waitFor("Heard a: drop (too old)", 10_000)
    expect(topic(s.w, "Check a")).toMatchObject({ state: "answered", answer: { id: "drop", text: "too old" } })
  })

  proves("S-0095", async (s) => {
    const t = termOf(s.term, "S-0095")
    for (const c of ["Check b", "Check c"]) {
      await highlight(t, c)
      t.press("space")
      await Bun.sleep(200)
    }
    await t.waitFor("2 marked", 5_000)
    // One answer for both: Keep.
    t.press("1")
    await t.waitFor("Heard b: keep", 10_000)
    await t.waitFor("Heard c: keep", 10_000)
    for (const c of ["Check b", "Check c"]) expect(topic(s.w, c)).toMatchObject({ state: "answered", answer: { id: "keep" } })
  })

  proves("S-0096", async (s) => {
    const t = termOf(s.term, "S-0096")
    const before = rows(t)
    s.note("buffer", "the inbox's rows before", before.join("\n"))
    expect(before[0]).toContain("Gate: go")
    await highlight(t, "Gate: go")
    t.press("z")
    // It waits at the end now.
    const until = Date.now() + 10_000
    while (Date.now() < until && !rows(t).at(-1)?.includes("Gate: go")) await Bun.sleep(100)
    s.note("buffer", "the inbox's rows after", rows(t).join("\n"))
    expect(rows(t).at(-1)).toContain("Gate: go")
    expect(topic(s.w, "Gate: go")?.snoozed).toBeDefined()
  })

  proves("S-0097", async (s) => {
    const t = termOf(s.term, "S-0097")
    await command(t, "/block")
    await toInbox(t)
    await t.waitFor("Probe waits for a go", 10_000)
    await highlight(t, "Probe waits for a go")
    t.press("z")
    await Bun.sleep(1_000)
    expect(rows(t)[0]).toContain("Probe waits for a go")
    const open = topics(s.w).find((x) => x.title === "Probe waits for a go" && x.state === "open")
    expect(open?.snoozed).toBeUndefined()
    // Answered, so the probe stops waiting before the session ends.
    t.press("1")
    await t.waitGone("Probe waits for a go", 10_000)
  })

  proves(
    "S-0098",
    async (s) => {
      liveModel(s.w)
      await quit(s.term)
      let t = await s.open()
      await answerLoads(t, "probe")
      await say(t, "I want to build a todo app. Ask me one question about who it is for.")
      // zarg's question, kept in the inbox.
      const until = Date.now() + 240_000
      let asked: ReturnType<typeof topics>[number] | undefined
      while (Date.now() < until && (asked = topics(s.w).find((x) => x.from.plugin === "zarg" && x.state === "open" && x.durable === true)) === undefined) await Bun.sleep(1_000)
      expect(asked).toBeDefined()
      s.note("buffer", "zarg's question", asked!.title)
      // The core restarts: quit and start again.
      await t.exit()
      t = await s.open()
      await answerLoads(t, "probe")
      await t.waitFor(asked!.title.slice(0, 30), 30_000)
      expect(topics(s.w).find((x) => x.id === asked!.id)?.state).toBe("open")
    },
    { model: true },
  )
})
