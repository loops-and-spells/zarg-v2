import { expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { nextOutcomes, nextWhenServed, rehearsing } from "../src/intent"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("what next: the outcomes no journey serves, in id order, each with its intent", () => {
  const snap = Snapshot.make([
    { id: "I-0001", type: "gherkin/intent", props: { title: "zarg", status: "accepted" }, edges: [{ type: "gherkin/has", to: "O-0002" }, { type: "gherkin/has", to: "O-0001" }, { type: "gherkin/has", to: "O-0003" }] },
    { id: "O-0001", type: "gherkin/outcome", props: { text: "One conversation" }, edges: [] },
    { id: "O-0002", type: "gherkin/outcome", props: { text: "The agent leads" }, edges: [] },
    { id: "O-0003", type: "gherkin/outcome", props: { text: "Served already" }, edges: [] },
    { id: "J-0001", type: "gherkin/journey", props: { name: "Talk" }, edges: [{ type: "gherkin/serves", to: "O-0003" }] },
  ] as never)
  expect(nextOutcomes(snap)).toEqual([
    { id: "O-0001", label: "One conversation", why: "zarg", task: 'Find or shape the journey that delivers O-0001 (One conversation), then link it with link {edge: "serves", journey, outcome: "O-0001"}.' },
    { id: "O-0002", label: "The agent leads", why: "zarg", task: 'Find or shape the journey that delivers O-0002 (The agent leads), then link it with link {edge: "serves", journey, outcome: "O-0002"}.' },
  ])
})

// @scenario S-0014
test("with every outcome served, what next offers the next steps: rehearse the journeys first, then extending a journey from its start", () => {
  const snap = Snapshot.make([
    { id: "ST-0001", type: "gherkin/state", props: { text: "Parent has chores to assign.", entry: true }, edges: [] },
    { id: "ST-0002", type: "gherkin/state", props: { text: "the chore is done" }, edges: [] },
  ] as never)
  const next = nextWhenServed(snap)
  expect(next[0]).toMatchObject({ id: "rehearse", label: "Rehearse the journeys" })
  expect(next[0]!.task).toContain("Rehearse.run")
  expect(next.slice(1).map((o) => o.label)).toEqual(['Extend the journey from "Parent has chores to assign."'])
})

test("while a rehearsal runs, what next does not offer one again", () => {
  const root = mkdtempSync(join(tmpdir(), "zt-rehearsing-"))
  const dir = join(root, ".zarg", "rehearse")
  mkdirSync(dir, { recursive: true })
  expect(rehearsing(root)).toBe(false)
  writeFileSync(join(dir, "index.json"), JSON.stringify(["r-1", "r-2"]))
  writeFileSync(join(dir, "r-2.json"), JSON.stringify({ run: "r-2", status: "running" }))
  expect(rehearsing(root)).toBe(true)
  const snap = Snapshot.make([{ id: "ST-0001", type: "gherkin/state", props: { text: "a start", entry: true }, edges: [] }] as never)
  expect(nextWhenServed(snap, undefined, undefined, false, undefined, true).map((o) => o.id)).toEqual(["ST-0001"])
  writeFileSync(join(dir, "r-2.json"), JSON.stringify({ run: "r-2", status: "done" }))
  expect(rehearsing(root)).toBe(false)
})

test("with nothing built (no scenario's code tagged), what next offers building first: rehearse walks only what is built", () => {
  const snap = Snapshot.make([
    { id: "ST-0001", type: "gherkin/state", props: { text: "a shelf of no books", entry: true }, edges: [] },
    { id: "S-0001", type: "gherkin/scenario", props: { title: "Reader adds a book", when: "adds" }, edges: [{ type: "gherkin/arrives", to: "ST-0001" }] },
  ] as never)
  const none = nextWhenServed(snap, undefined, new Set())
  expect(none[0]).toMatchObject({ id: "build" })
  expect(none[0]!.label).toContain("/reconcile")
  expect(none.map((o) => o.id)).toContain("rehearse")
  // One scenario built: rehearse leads again.
  expect(nextWhenServed(snap, undefined, new Set(["S-0001"]))[0]).toMatchObject({ id: "rehearse" })
})

test("with reconcile on, what next does not offer building: a pass builds them", () => {
  const snap = Snapshot.make([
    { id: "ST-0001", type: "gherkin/state", props: { text: "a shelf of no books", entry: true }, edges: [] },
    { id: "S-0001", type: "gherkin/scenario", props: { title: "Reader adds a book", when: "adds" }, edges: [{ type: "gherkin/arrives", to: "ST-0001" }] },
  ] as never)
  expect(nextWhenServed(snap, undefined, new Set(), true).map((o) => o.id)).not.toContain("build")
})
