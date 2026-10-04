import { expect, test } from "bun:test"
import { Schema } from "effect"
import { FiledEntry, ItemData } from "@zarg/plugin-backlog/contract"
import { seed } from "../src"

const filed = { ref: "gherkin/scenario:S-0001@aaaaaaaaaaaa", journeys: ["J"], persona: "Operator", kind: "bug", severity: "high", note: "the list is empty", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "real" } } as const

test("seeded feedback is a file the backlog reads: one per entry, under .zarg/feedback, with a stable id", () => {
  const files = seed.feedback([filed])
  const [[path, text]] = Object.entries(files) as [[string, string]]
  expect(path).toMatch(/^\.zarg\/feedback\/F-[0-9a-f]{8}\.json$/)
  const e = JSON.parse(text)
  expect(path).toBe(`.zarg/feedback/${e.id}.json`)
  expect(e).toMatchObject({ count: 1, triage: { on: true, by: "agent" } })
  expect(() => Schema.decodeUnknownSync(FiledEntry)(e)).not.toThrow()
  expect(seed.feedback([filed])).toEqual(files)
})

test("a seeded plan is a backlog item file in its lane", () => {
  const files = seed.plan({ id: "B-01", status: "backlog", title: "t", journey: "J", scenarios: [{ ref: "gherkin/scenario:S-0001@aaaaaaaaaaaa" }], changes: [], feedback: [], steps: ["s"] })
  const item = JSON.parse(files[".zarg/backlog/B-01.json"]!)
  expect(Schema.decodeUnknownSync(ItemData)(item)).toMatchObject({ id: "B-01", status: "backlog", events: [] })
})

test("seeded evidence is the scenario's evidence file with its media beside it", () => {
  const e = { scenario: "S-0001", version: "aaaaaaaaaaaa", commit: "abc", run: "e2e-1", journey: "J-0001", passed: true, flaky: false, at: "2026-10-04T00:00:00.000Z", ms: 1, media: [{ kind: "evidence-x/y", path: "media/S-0001/1-y.txt", caption: "a thing" }], failure: null, code: {} }
  const files = seed.evidence(e, { "media/S-0001/1-y.txt": "hi" })
  expect(JSON.parse(files[".zarg/evidence/S-0001.json"]!)).toEqual(e)
  expect(files[".zarg/evidence/media/S-0001/1-y.txt"]).toBe("hi")
})
