import { describe, expect, test } from "bun:test"
import { FrontmatterError, parse, stringify } from "../src"

const intent = `---
author: the operator (with Claude)
date: 2026-09-26
status: accepted
count: 3
ok: true
none: null
personas:
  - name: Operator
    kind: human
    text: "The person shaping their product: talks, answers, approves."
  - name: CLI actor
    kind: cli
    text: A coding agent # a comment
next:
- name: Capture
  why: 'the agent keeps it''s intents'
tags: []
---
# Intent

Body text.
`

describe("parse", () => {
  test("scalars, lists of maps (indented or not), quoted strings, comments, the body after", () => {
    const r = parse(intent)
    expect(r.data).toEqual({
      author: "the operator (with Claude)",
      date: "2026-09-26",
      status: "accepted",
      count: 3,
      ok: true,
      none: null,
      personas: [
        { name: "Operator", kind: "human", text: "The person shaping their product: talks, answers, approves." },
        { name: "CLI actor", kind: "cli", text: "A coding agent" },
      ],
      next: [{ name: "Capture", why: "the agent keeps it's intents" }],
      tags: [],
    })
    expect(r.body).toBe("# Intent\n\nBody text.\n")
  })
  test("no frontmatter: empty data, the whole text as body", () => {
    expect(parse("# Plan\ncard: x\n")).toEqual({ data: {}, body: "# Plan\ncard: x\n" })
  })
  test("plain lists and nested maps", () => {
    expect(parse("---\na:\n  - x\n  - 2\nb:\n  c: d\n  e:\n    f: g\n---\n").data).toEqual({ a: ["x", 2], b: { c: "d", e: { f: "g" } } })
  })
  test("mistakes are refused with their line: an unclosed block, a tab, bad indentation, a duplicate key, a line that is no key", () => {
    const line = (md: string) => {
      try {
        parse(md)
        return -1
      } catch (e) {
        expect(e).toBeInstanceOf(FrontmatterError)
        return (e as FrontmatterError).line
      }
    }
    expect(line("---\na: b\n")).toBe(1)
    expect(line("---\na:\n\t- b\n---\n")).toBe(3)
    expect(line("---\na: b\n    c: d\n---\n")).toBe(3)
    expect(line("---\na: b\na: c\n---\n")).toBe(3)
    expect(line("---\njust words\n---\n")).toBe(2)
    expect(line('---\na: "unclosed\n---\n')).toBe(2)
  })
})

describe("stringify", () => {
  test("round-trips what parse reads; strings that would read as something else are quoted", () => {
    const data = { scenario: "S-0075", hash: "82e586643ff1", n: "123", flag: "true", title: "Operator reads: a # b", list: [{ name: "A", text: "x" }], empty: [] }
    const md = stringify(data, "# Body\n")
    expect(md.startsWith("---\nscenario: S-0075\n")).toBe(true)
    expect(parse(md)).toEqual({ data, body: "# Body\n" })
  })
})
