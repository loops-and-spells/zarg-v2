import { expect } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answerLoads, journey, quit, type World } from "../src"

// zarg on scripted cells (the core's stub mode): each model turn runs the next cell, the last one repeats.
const SECRET = "zt-e2e-hush-4417"
const CELLS = [
  // The driver's first turns: output with a secret in it, a read of a local env file, a service its preset lacks.
  `console.log("the key is ${SECRET}")\nreturn "printed"`,
  'return yield* Fs.read({ path: ".env.local" })',
  "return yield* Verify.run({})",
  // Work handed to a child: it reads, slowly, and never finishes (its budget runs out; so would the driver's).
  'return yield* Rlm.exec({ task: "Read the README and say what the product is", preset: "research", scope: {} })',
  'yield* Effect.sleep("2 seconds")\nreturn "still reading"',
]
const STUB = join(mkdtempSync(join(tmpdir(), "zarg-e2e-stub-")), "cells.json")
// Decisions too: every yes/no judgment yes at 0.83, but "making progress?" no (a budget runs out, as it should).
writeFileSync(STUB, JSON.stringify({ cells: CELLS, decisions: { confidence: 0.83, no: ["progressing"] } }))
const SEED = {
  ".env.schema": "# @defaultSensitive=false\n# ---\n# A key the agents must never see.\n# @sensitive\nZT_E2E_SECRET=\n",
  ".env.local": `ZT_E2E_SECRET=${SECRET}\n`,
  "README.md": "# Chores\n\nA family chore tracker.\n",
}

/** The driver's RLM log: each cell's code, whether it ran, and its output. */
const cells = (w: World) => {
  const file = join(w.project, ".zarg/threads/main.rlm.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").trim().split("\n").flatMap((l) => {
    const e = JSON.parse(l) as { type: string; rlm?: string; cells?: Array<{ code: string; ok: boolean; output: string }> }
    return e.type === "step" ? (e.cells ?? []).map((c) => ({ rlm: e.rlm ?? "", ...c })) : []
  })
}
const raw = (w: World) => (existsSync(join(w.project, ".zarg/threads")) ? ["main.jsonl", "main.rlm.jsonl"].map((f) => (existsSync(join(w.project, ".zarg/threads", f)) ? readFileSync(join(w.project, ".zarg/threads", f), "utf8") : "")).join("\n") : "")
const until = async (check: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(300)
  return check()
}

journey("J-0003", { tier: "fast", seed: SEED, env: { ZARG_CORE_STUB: STUB } }, (proves) => {
  proves("S-0045", async (s) => {
    const t = await s.open()
    await answerLoads(t)
    expect(await until(() => cells(s.w).some((c) => c.code.includes("console.log")))).toBe(true)
    const printed = cells(s.w).find((c) => c.code.includes("console.log"))!
    s.note("buffer", "the cell's output, as kept", printed.output)
    expect(printed.output).toContain("<redacted:ZT_E2E_SECRET>")
    // Nowhere in what zarg keeps of the conversation.
    expect(raw(s.w)).not.toContain(SECRET)
  })

  proves("S-0046", async (s) => {
    expect(await until(() => cells(s.w).some((c) => c.code.includes(".env.local")))).toBe(true)
    const read = cells(s.w).find((c) => c.code.includes(".env.local"))!
    s.note("buffer", "the read", read.output)
    expect(read.ok).toBe(false)
    expect(read.output).toMatch(/env|secret|refused|not allowed/i)
  })

  proves("S-0048", async (s) => {
    expect(await until(() => cells(s.w).some((c) => c.code.includes("Verify.run")))).toBe(true)
    const used = cells(s.w).find((c) => c.code.includes("Verify.run"))!
    s.note("buffer", "the refusal", used.output)
    expect(used.ok).toBe(false)
    expect(used.output).toContain("did not run")
    expect(used.output).toContain("Verify")
  })

  proves("S-0041", async (s) => {
    const t = s.term!
    // The driver's row holds its child, folded: the operator opens it (→ on the row).
    t.press("esc")
    await Bun.sleep(300)
    t.press("alt+a")
    await t.waitFor(/▸.*driver 1/, 30_000)
    for (let k = 0; k < 5 && !/▍\s*▸.*driver 1/.test(t.screen()); k++) {
      t.press("down")
      await Bun.sleep(150)
    }
    t.press("right")
    await t.waitFor(/└.*research/, 10_000)
    s.note("buffer", "the agents", t.screen())
  })

  proves("S-0040", async (s) => {
    const t = s.term!
    s.note("buffer", "the agents at work", t.screen())
    // Each agent: its preset, its turns against its budget.
    expect(t.screen()).toMatch(/driver 1\s+\d+\/25/)
    expect(t.screen()).toMatch(/research\S*\s+\d+\/15/)
  })

  proves("S-0073", async (s) => {
    const t = s.term!
    t.press("down")
    await t.waitFor("Read the README", 10_000)
    s.note("buffer", "the child, highlighted", t.screen())
  })

  proves("S-0042", async (s) => {
    const t = s.term!
    // The child's decision (it runs directly: atomic), each criterion with its confidence.
    await t.waitFor(/single\s+yes\s+0\.83/, 10_000)
    s.note("buffer", "the decision", t.screen())
    expect(t.screen()).toContain("atomic (runs directly)")
  })

  proves("S-0074", async (s) => {
    const t = s.term!
    t.press("up")
    await Bun.sleep(200)
    t.press("left")
    await t.waitFor(/▸.*driver 1/, 10_000)
    s.note("buffer", "folded", t.screen())
    expect(t.screen()).not.toMatch(/└.*research/)
  })

  proves("S-0043", async (s) => {
    const t = s.term!
    // The child's budget runs out: its final report says so.
    expect(await until(() => raw(s.w).includes("did not finish within its budget"), 60_000)).toBe(true)
    s.note("buffer", "screen", t.screen())
  })

  proves("S-0044", async (s) => {
    const t = s.term!
    t.press("ctrl+c")
    await t.waitFor("(stopped)", 15_000)
    s.note("buffer", "stopped", t.screen())
    await quit(t)
  })
})
