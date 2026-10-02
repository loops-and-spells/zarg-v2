/**
 * Syntax highlighting as data: a source becomes lines of spans, each with an optional token kind. Platforms map
 * kinds to their colours (the terminal to its theme). No dependencies, no platform code; a language is one function
 * from a line to its spans, and every line's spans join back to the line exactly.
 */

export type Token = "keyword" | "id" | "comment" | "title" | "flow" | "string" | "number" | "persona" | "journey"
export interface Span {
  readonly text: string
  readonly token?: Token
}
export type Line = ReadonlyArray<Span>

const span = (text: string, token?: Token): ReadonlyArray<Span> => (text === "" ? [] : [token === undefined ? { text } : { text, token }])

/** Split text by a pattern: its matches take `token`, the text between them the pieces `rest` makes of it. */
const splitBy = (text: string, re: RegExp, token: Token, rest: (t: string) => ReadonlyArray<Span> = (t) => span(t)): ReadonlyArray<Span> => {
  const out: Array<Span> = []
  let at = 0
  for (const m of text.matchAll(re)) {
    out.push(...rest(text.slice(at, m.index)), ...span(m[0], token))
    at = m.index + m[0].length
  }
  return [...out, ...rest(text.slice(at))]
}

const ID = /\b(?:C|S|P|J|I|G|K|Q)-\d+\b/g
const QUOTED = /"[^"]*"/g
const NUMBER = /\b\d+(?:\.\d+)?\b/g
/** Prose inside a clause: quoted text, then numbers. */
const prose = (t: string) => splitBy(t, QUOTED, "string", (x) => splitBy(x, NUMBER, "number"))
/** Text and a trailing `  # …` comment. */
const withComment = (t: string, body: (x: string) => ReadonlyArray<Span>): ReadonlyArray<Span> => {
  const m = /^(.*?)(\s{2,})(#.*)$/.exec(t)
  return m === null ? body(t) : [...body(m[1]!), ...span(m[2]!), ...span(m[3]!, "comment")]
}

/** zarg's Gherkin, as its render and journey flows print it: cards, By / In / Given / When / Then lines, flow arrows. */
const gherkin = (line: string): Line => {
  const card = /^(C-\d+)( +)(.*)$/.exec(line)
  if (card !== null) return [...span(card[1]!, "id"), ...span(card[2]!), ...span(card[3]!, "title")]
  const step = /^(\s*)(Given|And|When|Then|By|In)\b(.*)$/.exec(line)
  if (step !== null) {
    // By names personas, In journeys: each name its token, the commas and spaces plain.
    const names = step[2] === "By" ? "persona" : step[2] === "In" ? "journey" : undefined
    const body = names === undefined ? prose : (t: string) => splitBy(t, /[^,\s][^,]*[^,\s]|[^,\s]/g, names)
    return [...span(step[1]!), ...span(step[2]!, "keyword"), ...withComment(step[3]!, body)]
  }
  const flow = /^(→|↺)(.*)$/.exec(line)
  if (flow !== null) return [...span(flow[1]!, "flow"), ...splitBy(flow[2]!, ID, "id")]
  const head = /^(\S.*?)(\s{2,})(#.*)$/.exec(line)
  if (head !== null) return [...span(head[1]!, "title"), ...span(head[2]!), ...span(head[3]!, "comment")]
  return span(line).length > 0 ? span(line) : [{ text: "" }]
}

export const languages: Readonly<Record<string, (line: string) => Line>> = { gherkin }

/** A source's lines as spans: the language's, or plain text for one it does not know. */
export const highlight = (lang: string, source: string): ReadonlyArray<Line> => {
  const of = languages[lang.toLowerCase()]
  return source.split("\n").map((l) => (of === undefined ? [{ text: l }] : of(l)))
}
