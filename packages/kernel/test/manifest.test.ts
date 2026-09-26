import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { manifest, tsType } from "../src"
import { Notes } from "./fixtures"

const ts = (s: Schema.Top) => {
  const d = Schema.toJsonSchemaDocument(s) as { schema: unknown; definitions?: Record<string, unknown> }
  return tsType(d.schema, d.definitions)
}

describe("tsType", () => {
  test("structs, optional keys, arrays, literals, unions, records, numbers", () => {
    expect(ts(Schema.Struct({ a: Schema.String, b: Schema.optionalKey(Schema.Number) }))).toBe("{ a: string; b?: number }")
    expect(ts(Schema.Array(Schema.Boolean))).toBe("ReadonlyArray<boolean>")
    expect(ts(Schema.Literals(["x", "y"]))).toBe('"x" | "y"')
    expect(ts(Schema.NullOr(Schema.String))).toBe("string | null")
    expect(ts(Schema.Record(Schema.String, Schema.Number))).toBe("Readonly<Record<string, number>>")
    expect(ts(Schema.Struct({}))).toBe("{}")
  })
})

describe("manifest", () => {
  test("declares each service with its doc lines and typed methods", () => {
    const text = manifest([Notes])
    expect(text).toContain("/** A tiny note store for tests. */\ndeclare const Notes: {")
    expect(text).toContain("  /** Store a note; returns its id. */\n  add(params: { text: string }): Eff<{ id: string }>")
    expect(text).toContain("interface Eff<A>")
  })
  test("a recursive schema does not crash the manifest", () => {
    interface Tree { readonly label: string; readonly children: ReadonlyArray<Tree> }
    const Tree: Schema.Codec<Tree> = Schema.Struct({ label: Schema.String, children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)) })
    expect(ts(Tree)).toContain("label: string")
  })
})
