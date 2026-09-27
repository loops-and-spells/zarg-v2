import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { Answer, DecisionRequest } from "@zarg/decisions"
import type { AgendaItem } from "@zarg/plugin/server"
import { judgeGaps, unbuiltCards } from "../src/gaps"

const item = (id: string, title: string): AgendaItem => ({ id, title, detail: `${title}: add a failure case?`, about: [id], priority: 1 })

describe("what-next gaps", () => {
  test("each candidate is judged on its own card; only a likely yes is kept", async () => {
    const calls: Array<DecisionRequest> = []
    const p: Record<string, number> = { "The developer pays": 0.82, "The page scrolls": 0.12, "The plugin loads": 0.66 }
    const decide = (req: DecisionRequest) =>
      Effect.sync(() => {
        calls.push(req)
        const key = Object.keys(p).find((k) => req.state.includes(k))!
        const yes = p[key]! >= 0.5
        return Object.fromEntries(Object.keys(req.questions).map((q) => [q, { type: "noul", answer: yes, probability: p[key]!, confidence: 0.1 } satisfies Answer]))
      })
    const kept = await Effect.runPromise(judgeGaps(decide, [item("S-1", "The developer pays"), item("S-2", "The page scrolls"), item("S-3", "The plugin loads")]))
    expect(kept.map((g) => g.id)).toEqual(["S-1"])
    expect(calls.length).toBe(3)
  })

  test("without a decision model, no failure candidates are offered", async () => {
    const decide = () => Effect.fail({ _tag: "DecisionError" as const, kind: "unavailable" as const, message: "down" })
    expect(await Effect.runPromise(judgeGaps(decide, [item("S-1", "x")]))).toEqual([])
  })

  test("cards with no @card tag in tracked files are unbuilt", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-gaps-"))
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, env: process.env })
    writeFileSync(join(root, "a.ts"), "// @card UX-0001\nexport const a = 1\n")
    Bun.spawnSync(["git", "add", "."], { cwd: root, env: process.env })
    expect(await Effect.runPromise(unbuiltCards(root, ["UX-0001", "UX-0002", "UX-0003"]))).toEqual(["UX-0002", "UX-0003"])
  })
})
