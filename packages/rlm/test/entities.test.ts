import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeChecker, manifest } from "@zarg/kernel"
import { Snapshot } from "@zarg/graph"
import { entitiesService } from "../src/services/entities"

const host = {
  entities: {
    types: () => [{ type: "gherkin/card", doc: "cards", tone: "card", glyph: "◇", commands: [], data: { schema: { type: "object", properties: { props: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, edges: { type: "array", items: {} } }, required: ["props", "edges"] }, definitions: {} } }],
    many: (refs: ReadonlyArray<string>) => Effect.succeed({ entities: refs.map((r) => ({ ref: r, type: "gherkin/card", id: r.split(":")[1]!, version: "abc", label: { text: "t", tone: "card", glyph: "◇" }, data: {} })), failed: [] }),
    query: () => Effect.succeed(["S-0001", "S-0002"].map((id) => ({ ref: `gherkin/card:${id}@abc`, type: "gherkin/card", id, version: "abc", label: { text: id, tone: "card", glyph: "◇" }, data: { props: { title: id }, edges: [] } }))),
    get: (ref: string) => Effect.succeed({ ref: `${ref}@abc`, type: "gherkin/card", id: ref.split(":")[1]!, version: "abc", label: { text: "t", tone: "card", glyph: "◇" }, data: { title: "t" } }),
  },
} as never
const snapshot = Effect.succeed(Snapshot.make([{ id: "S-0001", type: "gherkin/card", props: {}, edges: [] }, { id: "S-0002", type: "gherkin/card", props: {}, edges: [] }] as never))

describe("the Entities service", () => {
  test("its declarations type get by kind: a discriminated union on type", () => {
    const text = manifest([entitiesService({ host, snapshot, scope: {} as never }, { write: false }).def])
    expect(text).toContain('type: "gherkin/card"')
    expect(text).toContain("title: string")
    expect(text).not.toContain("command(")
  })
  test("a graph ref outside the RLM's scope fails with OutOfScope", async () => {
    const svc = entitiesService({ host, snapshot, scope: { graph: { focus: ["S-0001"], k: 0 } } as never }, { write: false })
    const out = await Effect.runPromise(Effect.flip(svc.handlers.get!({ ref: "gherkin/card:S-0002" })) as unknown as Effect.Effect<{ _tag: string }>)
    expect(out._tag).toBe("OutOfScope")
  })
  test("a cell reads a kind's data after narrowing on type; a misspelt field fails the check", () => {
    const checker = makeChecker(manifest([entitiesService({ host, snapshot, scope: {} as never }, { write: false }).def]))
    expect(checker.check('const e = yield* Entities.get({ ref: "gherkin/card:S-0001" })\nif (e.type === "gherkin/card") console.log(e.data.props.title)').ok).toBe(true)
    expect(checker.check('const e = yield* Entities.get({ ref: "gherkin/card:S-0001" })\nif (e.type === "gherkin/card") console.log(e.data.title)').ok).toBe(false)
  })
  test("query keeps graph entities inside the RLM's scope", async () => {
    const svc = entitiesService({ host, snapshot, scope: { graph: { focus: ["S-0001"], k: 0 } } as never }, { write: false })
    const out = (await Effect.runPromise(svc.handlers.query!({ type: "gherkin/card" }) as Effect.Effect<Array<{ id: string }>>)).map((e) => e.id)
    expect(out).toEqual(["S-0001"])
  })
  test("many lists an out-of-scope ref among its failures and serves the rest", async () => {
    const svc = entitiesService({ host, snapshot, scope: { graph: { focus: ["S-0001"], k: 0 } } as never }, { write: false })
    const out = (await Effect.runPromise(svc.handlers.many!({ refs: ["gherkin/card:S-0001", "gherkin/card:S-0002"] }) as Effect.Effect<{ entities: Array<{ id: string }>; failed: Array<{ ref: string; _tag: string; message: string }> }>))
    expect(out.entities.map((e) => e.id)).toEqual(["S-0001"])
    expect(out.failed).toEqual([{ ref: "gherkin/card:S-0002", _tag: "OutOfScope", message: expect.stringContaining("scope") }])
  })
  test("two kinds' same-named schema definitions do not overwrite each other", () => {
    const two = {
      entities: {
        types: () => [
          { type: "a/x", doc: "", tone: "accent", glyph: "a", commands: [], data: { schema: { $ref: "#/$defs/Item" }, definitions: { Item: { type: "object", properties: { alpha: { type: "string" } }, required: ["alpha"] } } } },
          { type: "b/y", doc: "", tone: "accent", glyph: "b", commands: [], data: { schema: { $ref: "#/$defs/Item" }, definitions: { Item: { type: "object", properties: { beta: { type: "number" } }, required: ["beta"] } } } },
        ],
      },
    } as never
    const text = manifest([entitiesService({ host: two, snapshot, scope: {} as never }, { write: false }).def])
    expect(text).toContain("alpha: string")
    expect(text).toContain("beta: number")
  })
})
