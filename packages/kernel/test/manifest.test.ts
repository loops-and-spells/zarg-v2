import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { defineService, makeChecker, manifest, tsType } from "../src"
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

describe("readable declarations", () => {
  const Ask = defineService("Ask", "Ask a question.", {
    ask: {
      doc: "Ask with options.",
      params: Schema.Struct({
        question: Schema.String.annotate({ description: "One sentence." }),
        options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
        about: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Card or state ids this question is about, not per option." }),
      }),
      success: Schema.Struct({ choice: Schema.optionalKey(Schema.String) }),
    },
  })

  test("a struct with described fields is laid out one field per line, each description as a doc comment", () => {
    expect(ts(Schema.Struct({ a: Schema.String.annotate({ description: "The a. Ends */ here." }), b: Schema.Number }))).toBe(
      "{\n  /** The a. Ends *\\/ here. */\n  a: string\n  b: number\n}",
    )
  })

  test("a long struct goes over several lines even without descriptions; short ones stay inline", () => {
    const long = Schema.Struct({ first: Schema.String, second: Schema.String, third: Schema.String, fourth: Schema.String, fifth: Schema.String })
    expect(ts(long)).toBe("{\n  first: string\n  second: string\n  third: string\n  fourth: string\n  fifth: string\n}")
    expect(ts(Schema.Struct({ id: Schema.String, label: Schema.String }))).toBe("{ id: string; label: string }")
  })

  test("nested layouts indent under the method, and the checker still rejects a field in the wrong place", () => {
    const text = manifest([Ask])
    expect(text).toContain(
      [
        "  /** Ask with options. */",
        "  ask(params: {",
        "    /** One sentence. */",
        "    question: string",
        "    options: ReadonlyArray<{ id: string; label: string }>",
        "    /** Card or state ids this question is about, not per option. */",
        "    about?: ReadonlyArray<string>",
        "  }): Eff<{ choice?: string }>",
      ].join("\n"),
    )
    const checker = makeChecker(text)
    expect(checker.check('yield* Ask.ask({ question: "q", options: [{ id: "a", label: "A" }], about: ["UX-1"] })').ok).toBe(true)
    expect(checker.check('yield* Ask.ask({ question: "q", options: [{ id: "a", label: "A", about: ["UX-1"] }] })').ok).toBe(false)
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
