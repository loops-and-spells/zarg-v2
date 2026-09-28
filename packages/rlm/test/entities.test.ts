import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeChecker, manifest } from "@zarg/kernel"
import { Snapshot } from "@zarg/graph"
import { entitiesService } from "../src/services/entities"

const host = {
  entities: {
    types: () => [{ type: "gherkin/card", doc: "cards", tone: "card", glyph: "◇", commands: [], data: { schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, definitions: {} } }],
    get: (ref: string) => Effect.succeed({ ref: `${ref}@abc`, type: "gherkin/card", id: ref.split(":")[1]!, version: "abc", label: { text: "t", tone: "card", glyph: "◇" }, data: { title: "t" } }),
  },
} as never
const snapshot = Effect.succeed(Snapshot.make([{ id: "UX-0001", type: "gherkin/card", props: {}, edges: [] }, { id: "UX-0002", type: "gherkin/card", props: {}, edges: [] }] as never))

describe("the Entities service", () => {
  test("its declarations type get by kind: a discriminated union on type", () => {
    const text = manifest([entitiesService({ host, snapshot, scope: {} as never }, { write: false }).def])
    expect(text).toContain('type: "gherkin/card"')
    expect(text).toContain("title: string")
    expect(text).not.toContain("command(")
  })
  test("a graph ref outside the RLM's scope fails with OutOfScope", async () => {
    const svc = entitiesService({ host, snapshot, scope: { graph: { focus: ["UX-0001"], k: 0 } } as never }, { write: false })
    const out = await Effect.runPromise(Effect.flip(svc.handlers.get!({ ref: "gherkin/card:UX-0002" })) as unknown as Effect.Effect<{ _tag: string }>)
    expect(out._tag).toBe("OutOfScope")
  })
  test("a cell reads a kind's data after narrowing on type; a misspelt field fails the check", () => {
    const checker = makeChecker(manifest([entitiesService({ host, snapshot, scope: {} as never }, { write: false }).def]))
    expect(checker.check('const e = yield* Entities.get({ ref: "gherkin/card:UX-0001" })\nif (e.type === "gherkin/card") console.log(e.data.title)').ok).toBe(true)
    expect(checker.check('const e = yield* Entities.get({ ref: "gherkin/card:UX-0001" })\nif (e.type === "gherkin/card") console.log(e.data.titel)').ok).toBe(false)
  })
})
