import { expect } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answerLoads, command, journey, PROBE, quit, type Term, type World } from "../src"

// zarg on scripted cells (the core's stub mode): each model turn runs the next cell, the last one repeats.
// Only zarg's driver asks the model here: the plugins that would (rehearse, triage, intent) are not loaded.
const CELLS = [
  // 1: a question with options, then the change it leads to, shown and written.
  [
    'const a = yield* Inquire.ask({ question: "Who uses the chore tracker first?", options: [{ id: "parent", label: "A parent", recommended: true, why: "they assign the chores" }, { id: "child", label: "A child" }] })',
    'const c = yield* Inquire.confirm({ change: "Add persona Parent (human): a parent who assigns chores." })',
    'if (c.choice === "add") yield* Gherkin.addPersona({ name: "Parent", kind: "human", text: "a parent who assigns chores." })',
    'yield* Rlm.done({ value: `You picked ${a.choice}.` })',
  ].join("\n"),
  // 2: the next question, answered in the operator's own words; a reply in Markdown.
  [
    'const a = yield* Inquire.ask({ question: "Where does the parent start?", options: [{ id: "list", label: "The family list", recommended: true }, { id: "child", label: "The child page" }] })',
    'const where = String(a.other ?? a.choice)',
    'const c = yield* Inquire.confirm({ change: `Add entry state: ${where}` })',
    'if (c.choice === "add") yield* Gherkin.addState({ text: where, entry: true })',
    'yield* Rlm.done({ value: "## Saved\\n\\n- **Parent** starts at: " + where + "\\n\\n| step | state |\\n|---|---|\\n| 1 | saved |\\n\\n`zarg` keeps it." })',
  ].join("\n"),
  // 3: a slow turn (the working line), then a diagram.
  'yield* Effect.sleep("6 seconds")\nyield* Rlm.done({ value: "The flow so far:\\n\\n```mermaid\\nflowchart LR\\n  A[Parent] --> B[Family list]\\n```\\n\\nThat is all for now." })',
  // 4: a question the operator talks about; the driver then chooses for them, saying why.
  [
    'const a = yield* Inquire.ask({ question: "Which chore comes first?", options: [{ id: "dishes", label: "The dishes", recommended: true }, { id: "trash", label: "The trash" }] })',
    'if (a.interjected === true && a.question !== undefined) {',
    '  const c = yield* Inquire.choose({ question: a.question, choice: "dishes", why: "you said the dishes pile up" })',
    // A diagram too wide for the window: its source shows as code, the text around it formatted.
    `  yield* Rlm.done({ value: "Chose " + c.choice + " for you. A **wide** flow:\\n\\n\`\`\`mermaid\\nflowchart LR\\n${["Parent opens the list", "Parent picks a chore", "Parent picks a child", "Child sees the chore", "Child does the chore", "Parent sees it done"].map((l, i) => `  N${i}[${l}] --> N${i + 1}`).slice(0, 5).join("\\n")}\\n\`\`\`\\n\\nToo wide to draw." })`,
    '} else yield* Rlm.done({ value: `You picked ${a.choice}.` })',
  ].join("\n"),
  // 5: a change shown about P-0001; another hand edits P-0001 before the answer: the save is refused as stale.
  [
    'const c = yield* Inquire.confirm({ change: "Edit persona Parent: a parent who assigns and checks chores.", about: ["P-0001"] })',
    'const r: unknown = c.choice === "add" ? yield* Effect.catch(Gherkin.editPersona({ id: "P-0001", text: "a parent who assigns and checks chores." }), (e) => Effect.succeed({ refused: e })) : "skipped"',
    'const said = JSON.stringify(r)',
    // Said, and the item goes on (the next cell asks what next).
    'return `The edit: ${said.includes("refused") ? "refused " + said : "saved"}`',
  ].join("\n"),
  // 5b: a rename shown about P-0001; another hand rewords its text meanwhile: other parts, so both hold (merged, said).
  [
    'const c = yield* Inquire.confirm({ change: "Rename persona Parent to Guardian", about: ["P-0001"] })',
    'const r: unknown = c.choice === "add" ? yield* Effect.catch(Gherkin.editPersona({ id: "P-0001", name: "Guardian" }), (e) => Effect.succeed({ refused: e })) : "skipped"',
    'return `The rename: ${JSON.stringify(r).includes("refused") ? "refused" : "saved"}`',
  ].join("\n"),
  // 5c: a text edit shown; another hand rewords the same text: refused, and the merge question asks which version stays.
  [
    'const c = yield* Inquire.confirm({ change: "Edit persona Guardian: a guardian who checks every chore.", about: ["P-0001"] })',
    'const r: unknown = c.choice === "add" ? yield* Effect.catch(Gherkin.editPersona({ id: "P-0001", text: "a guardian who checks every chore." }), (e) => Effect.succeed({ refused: e })) : "skipped"',
    'if (JSON.stringify(r).includes("StaleNode")) {',
    '  const q = yield* Inquire.ask({ question: "Another edit changed the guardian\'s text: which version stays?", options: [{ id: "theirs", label: "Keep theirs", change: "Keep persona Guardian\'s text as the other edit set it" }, { id: "mine", label: "Use mine", recommended: true, change: "Edit persona Guardian: a guardian who checks every chore." }] })',
    '  if (q.choice === "mine") yield* Gherkin.editPersona({ id: "P-0001", text: "a guardian who checks every chore." })',
    '  return `Kept: ${q.choice}`',
    '}',
    'return "saved"',
  ].join("\n"),
  // 6: a question the operator answers with a message: the driver weighs it and asks again.
  [
    'const a = yield* Inquire.ask({ question: "How often are chores due?", options: [{ id: "daily", label: "Every day", recommended: true }, { id: "weekly", label: "Every week" }] })',
    'if (a.interjected === true) {',
    '  const b = yield* Inquire.ask({ question: "Should each chore have its own schedule?", options: [{ id: "yes", label: "Yes, per chore", recommended: true }, { id: "no", label: "No, one for all" }] })',
    '  return `Schedules: ${b.choice ?? b.other}`',
    '}',
    'return `Due: ${a.choice}`',
  ].join("\n"),
  // Then, the agenda empty, what next (from the gaps the item names).
  'const a = yield* Inquire.ask({ question: "What should we work on next?", options: [{ id: "fail", label: "A failure case", recommended: true }, { id: "journey", label: "Another journey" }] })\nyield* Rlm.done({ value: `Next: ${a.choice ?? a.other}` })',
]
const STUB = join(mkdtempSync(join(tmpdir(), "zarg-e2e-stub-")), "cells.json")
writeFileSync(STUB, JSON.stringify({ cells: CELLS }))

const nodes = (w: World, prefix: string) => {
  const dir = join(w.project, ".zarg/graph/nodes")
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; props: Record<string, unknown> }) : []
}
const git = (w: World, ...args: Array<string>) => Bun.spawnSync(["git", ...args], { cwd: w.project, env: w.env }).stdout.toString().trim()
journey("J-0001", { tier: "fast", env: { ZARG_CORE_STUB: STUB } }, (proves) => {
  // zarg's questions come up in its sheet, the picker under them (the sheet opens when zarg asks).
  proves("S-0008", async (s) => {
    // The probe plugin (it writes reports in Markdown, S-0076), installed and allowed; the rest are not loaded.
    expect((await s.cli(["plugin", "build", PROBE])).code).toBe(0)
    expect((await s.cli(["plugin", "add", join(PROBE, "dist")])).code).toBe(0)
    mkdirSync(join(s.w.project, ".zarg"), { recursive: true })
    writeFileSync(join(s.w.project, ".zarg", "config.toml"), `[plugins.probe]\nsource = ${JSON.stringify(join(PROBE, "dist"))}\n`)
    const t = await s.open()
    await answerLoads(t, "probe")
    await t.waitFor("Who uses the chore tracker first?", 30_000)
    s.note("buffer", "the question", t.screen())
    expect(t.screen()).toMatch(/›\s*A parent \(recommended\)/)
    expect(t.screen()).toContain("A child")
  })

  proves("S-0009", async (s) => {
    const t = s.term!
    await t.choose("A parent", "down", "Who uses the chore tracker first?")
    // The change it leads to: shown whole, then added.
    await t.waitFor("Add persona Parent (human)", 30_000)
    await t.choose("Write it", "down", "Add persona Parent (human)")
    expect(await waitFor(() => nodes(s.w, "P-").some((p) => p.props.name === "Parent"))).toBe(true)
    // Committed once the change is written and the item ends.
    expect(await waitFor(() => git(s.w, "log", "--format=%s").includes("req: P-0001"))).toBe(true)
    s.note("buffer", "git log", git(s.w, "log", "--format=%s"))
  })

  proves("S-0010", async (s) => {
    const t = s.term!
    await t.waitFor("Where does the parent start?", 30_000)
    s.note("buffer", "the next question", t.screen())
    expect(t.screen()).toMatch(/›\s*The family list \(recommended\)/)
  })

  proves("S-0011", async (s) => {
    const t = s.term!
    // Their own words: Something else…, typed in the bar.
    await t.choose("Something else", "down", "Where does the parent start?")
    t.type("the chores board")
    await t.waitFor("the chores board", 5_000)
    t.press("enter")
    await t.waitFor("Add entry state: the chores board", 30_000)
    await t.choose("Write it", "down", "Add entry state: the chores board")
    expect(await waitFor(() => nodes(s.w, "ST-").some((n) => n.props.text === "the chores board"))).toBe(true)
  })

  proves("S-0075", async (s) => {
    const t = s.term!
    await t.waitFor("keeps it", 30_000)
    s.note("buffer", "zarg's reply", t.screen())
    // Markdown, formatted: no raw markers.
    expect(t.screen()).not.toContain("## Saved")
    expect(t.screen()).not.toContain("**Parent**")
    expect(t.screen()).toMatch(/step\s+│?\s*state/)
  })

  proves("S-0072", async (s) => {
    const t = s.term!
    await t.waitFor(/preparing a reply · 0:0\d · turn \d+\/25/, 30_000)
    s.note("buffer", "the working line", t.screen())
  })

  proves("S-0077", async (s) => {
    const t = s.term!
    await t.waitFor("That is all for now", 30_000)
    s.note("buffer", "the diagram", t.screen())
    expect(t.screen()).not.toContain("```mermaid")
    expect(t.screen()).toMatch(/Parent[\s\S]*Family list/)
  })

  proves("S-0012", async (s) => {
    const t = s.term!
    await t.waitFor("Which chore comes first?", 30_000)
    await t.choose("Chat about this", "down", "answer zarg above")
    t.type("the dishes pile up every night")
    await t.waitFor("pile up every night", 5_000)
    t.press("enter")
    s.note("buffer", "the question under discussion", t.screen())
  })

  proves("S-0071", async (s) => {
    const t = s.term!
    await t.waitFor("zarg chose The dishes for you", 30_000)
    s.note("buffer", "zarg's choice", t.screen())
    expect(t.screen()).toContain("you said the dishes pile up")
  })

  proves("S-0078", async (s) => {
    const t = s.term!
    await openSheet(t)
    await t.waitFor("Too wide to draw", 30_000)
    s.note("buffer", "the wide diagram", t.screen())
    // Its source as code, the text around it formatted.
    expect(t.screen()).toContain("flowchart LR")
    expect(t.screen()).not.toContain("**wide**")
  })

  proves("S-0016", async (s) => {
    const t = s.term!
    await t.waitFor("Edit persona Parent: a parent who assigns and checks chores.", 60_000)
    // Another hand (a CLI actor) edits P-0001 while the operator reads the change.
    const other = await s.cli(["tool", "call", "gherkin/edit-persona", JSON.stringify({ id: "P-0001", text: "a parent who sets the chores." })])
    expect(other.code).toBe(0)
    await t.choose("Write it", "down", "Edit persona Parent: a parent who assigns and checks chores.")
    // The save is refused as stale: what the driver got back.
    const rlm = () => readFileSync(join(s.w.project, ".zarg/threads/main.rlm.jsonl"), "utf8")
    expect(await waitFor(() => /The edit: refused[^\n]*StaleNode/.test(rlm()))).toBe(true)
    s.note("log", "what the driver got back", rlm().split("\n").filter((l) => l.includes("The edit:")).join("\n"))
    expect(nodes(s.w, "P-").find((p) => p.id === "P-0001")?.props.text).toBe("a parent who sets the chores.")
  })

  // @scenario S-0017
  proves("S-0017", async (s) => {
    const t = s.term!
    await t.waitFor("Rename persona Parent to Guardian", 60_000)
    // Another hand rewords the persona's text: not the part this change renames.
    expect((await s.cli(["tool", "call", "gherkin/edit-persona", JSON.stringify({ id: "P-0001", text: "a parent who checks the chores." })])).code).toBe(0)
    await t.choose("Write it", "down", "Rename persona Parent to Guardian")
    await t.waitFor("Merged with another edit to P-0001", 30_000)
    s.note("buffer", "the merge, said", t.screen())
    expect(nodes(s.w, "P-").find((p) => p.id === "P-0001")?.props).toMatchObject({ name: "Guardian", text: "a parent who checks the chores." })
  })

  proves("S-0018", async (s) => {
    const t = s.term!
    await t.waitFor("Edit persona Guardian: a guardian who checks every chore.", 60_000)
    // Another hand rewords the same text: the two edits conflict.
    expect((await s.cli(["tool", "call", "gherkin/edit-persona", JSON.stringify({ id: "P-0001", text: "a guardian who sets the chores." })])).code).toBe(0)
    // Gone once the confirm is: the merge question shows the same words (as an option's change).
    await t.choose("Write it", "down", "Write this to the requirements?")
    await t.waitFor("which version stays?", 30_000)
    s.note("buffer", "the merge question", t.screen())
    expect(t.screen()).toContain("Keep theirs")
    expect(t.screen()).toContain("Use mine")
  })

  proves("S-0019", async (s) => {
    const t = s.term!
    await t.choose("Use mine", "down", "which version stays?")
    expect(await waitFor(() => nodes(s.w, "P-").find((p) => p.id === "P-0001")?.props.text === "a guardian who checks every chore.")).toBe(true)
  })

  proves("S-0013", async (s) => {
    const t = s.term!
    await t.waitFor("How often are chores due?", 60_000)
    await t.choose("Chat about this", "down", "answer zarg above")
    t.type("it depends on the chore")
    await t.waitFor("depends on the chore", 5_000)
    t.press("enter")
    await t.waitFor("Should each chore have its own schedule?", 30_000)
    s.note("buffer", "the next question", t.screen())
    await t.choose("Yes, per chore", "down", "Should each chore have its own schedule?")
  })

  proves("S-0014", async (s) => {
    const t = s.term!
    // Nothing on the agenda: the item asks what next, with the gaps found in the graph to choose from.
    await t.waitFor("What should we work on next?", 120_000)
    s.note("buffer", "what next", t.screen())
    expect(starts(s.w).at(-1)).toContain("The agenda is empty")
  })

  proves("S-0015", async (s) => {
    const t = s.term!
    // The recommended topic: it is the driver's next word.
    await t.choose("A failure case", "down", "What should we work on next?")
    expect(await waitFor(() => readFileSync(join(s.w.project, ".zarg/threads/main.rlm.jsonl"), "utf8").includes('"choice":"fail"'))).toBe(true)
  })

  proves("S-0076", async (s) => {
    const t = s.term!
    t.press("esc")
    await Bun.sleep(300)
    await command(t, "/report")
    await t.waitFor("report written", 15_000)
    // The agent's view, opened from the list.
    t.press("alt+a")
    await t.waitFor(/report\s+done/, 10_000)
    for (let k = 0; k < 12 && !/▍.*report\s+done/.test(t.screen()); k++) {
      t.press("down")
      await Bun.sleep(150)
    }
    t.press("enter")
    await t.waitFor("What the probe found", 10_000)
    s.note("buffer", "the report", t.screen())
    // Markdown, formatted: no raw markers; the table drawn.
    expect(t.screen()).not.toContain("## What")
    expect(t.screen()).not.toContain("**two**")
    expect(t.screen()).toMatch(/note\s+│?\s*state/)
    await quit(t)
  })
})

/** zarg's sheet over the view, where its replies are. */
const openSheet = async (t: Term) => {
  t.press("esc")
  await Bun.sleep(300)
  t.press("alt+m")
  await Bun.sleep(300)
  if (!t.screen().includes("esc closes")) t.press("alt+m")
  await t.waitFor("esc closes", 5_000)
}
const starts = (w: World) =>
  readFileSync(join(w.project, ".zarg/threads/main.rlm.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; task?: string; parent?: string | null }).filter((e) => e.type === "start" && e.parent === "zarg").map((e) => String(e.task))

async function waitFor(check: () => boolean, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await Bun.sleep(500)
  }
  return check()
}
