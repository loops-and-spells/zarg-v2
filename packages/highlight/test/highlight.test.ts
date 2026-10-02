import { describe, expect, test } from "bun:test"
import { highlight, languages } from "../src"

/** A line as "token:text" pieces (plain text as just its text), for readable expectations. */
const show = (lang: string, src: string) => highlight(lang, src).map((line) => line.map((s) => (s.token === undefined ? s.text : `${s.token}:${s.text}`)))

describe("gherkin", () => {
  test("a scenario: its id and title, keywords, quoted text, and the # ids as a comment", () => {
    expect(show("gherkin", 'S-0003 Visitor picks Pro\n  Given the plan picker is shown  # ST-0002\n  When  the visitor clicks "Pricing"\n  Then  2 plans show  # ST-0004')).toEqual([
      ["id:S-0003", " ", "title:Visitor picks Pro"],
      ["  ", "keyword:Given", " the plan picker is shown", "  ", "comment:# ST-0002"],
      ["  ", "keyword:When", "  the visitor clicks ", 'string:"Pricing"'],
      ["  ", "keyword:Then", "  ", "number:2", " plans show", "  ", "comment:# ST-0004"],
    ])
  })
  test("By and In lines, the journey head, and the flow's arrows with the ids they point at", () => {
    expect(show("gherkin", "Checkout  # J-0001 · 2 scenarios\n  By    Operator  # P-0001\n→ S-0002 or S-0003 (branches)\n↺ back to S-0001")).toEqual([
      ["title:Checkout", "  ", "comment:# J-0001 · 2 scenarios"],
      ["  ", "keyword:By", "    ", "persona:Operator", "  ", "comment:# P-0001"],
      ["flow:→", " ", "id:S-0002", " or ", "id:S-0003", " (branches)"],
      ["flow:↺", " back to ", "id:S-0001"],
    ])
  })
  test("every line keeps all its text: joining the pieces gives the source back", () => {
    const src = 'S-1 t\n  And   a "b" c  # ST-1\nNot connected to the journey\'s other scenarios:\n\n  weird\tline'
    expect(highlight("gherkin", src).map((l) => l.map((s) => s.text).join("")).join("\n")).toBe(src)
  })
})

describe("gherkin: who and where", () => {
  test("a By line's names are personas, an In line's are journeys (commas between them are plain)", () => {
    expect(show("gherkin", "  By    Operator, Driver Agent\n  In    Set up, Reconcile  # J-0002, J-0004")).toEqual([
      ["  ", "keyword:By", "    ", "persona:Operator", ", ", "persona:Driver Agent"],
      ["  ", "keyword:In", "    ", "journey:Set up", ", ", "journey:Reconcile", "  ", "comment:# J-0002, J-0004"],
    ])
  })
})

describe("languages", () => {
  test("an unknown language is plain text, line by line; gherkin is known", () => {
    expect(show("nope", "a\nb")).toEqual([["a"], ["b"]])
    expect(Object.keys(languages)).toContain("gherkin")
  })
})
