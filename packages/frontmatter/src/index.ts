/**
 * Frontmatter: the parsable data at the top of a Markdown file, between `---` lines, in a YAML subset:
 * `key: value` maps, `- item` lists (of scalars or maps), nested by indentation (spaces), scalars that are
 * plain or quoted ("..." with JSON escapes, '...' with '' for a quote), numbers, true, false, null, and `[]` or
 * `{}` for empty ones; `#` starts a comment. Anything else is refused with its line. No dependencies, so it runs
 * inside the plugin sandbox.
 */

export type Value = string | number | boolean | null | ReadonlyArray<Value> | { readonly [key: string]: Value }

export class FrontmatterError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`frontmatter line ${line}: ${message}`)
  }
}

interface Line {
  readonly n: number
  readonly indent: number
  readonly text: string
}

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_ .-]*?):(?:\s+(.*))?$/

/** A plain scalar's comment: ` #` to the end. */
const uncomment = (s: string) => {
  const i = s.search(/\s#/)
  return (i < 0 ? s : s.slice(0, i)).trim()
}

const scalar = (raw: string, n: number): Value => {
  const s = raw.trim()
  if (s.startsWith('"')) {
    const end = s.lastIndexOf('"')
    if (end <= 0) throw new FrontmatterError(n, "an unclosed double quote")
    try {
      return JSON.parse(s.slice(0, end + 1)) as string
    } catch {
      throw new FrontmatterError(n, "a bad double-quoted string")
    }
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(s)
    if (m === null) throw new FrontmatterError(n, "an unclosed single quote")
    return m[1]!.replace(/''/g, "'")
  }
  const v = uncomment(s)
  if (v === "[]") return []
  if (v === "{}") return {}
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null" || v === "~" || v === "") return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

const isItem = (l: Line) => l.text === "-" || l.text.startsWith("- ")

const block = (lines: ReadonlyArray<Line>, at: number, indent: number): [Value, number] =>
  isItem(lines[at]!) ? list(lines, at, indent) : map(lines, at, indent)

const list = (lines: ReadonlyArray<Line>, start: number, indent: number): [Value, number] => {
  const out: Array<Value> = []
  let i = start
  while (i < lines.length && lines[i]!.indent === indent && isItem(lines[i]!)) {
    const l = lines[i]!
    const rest = l.text.slice(1).trim()
    if (rest === "") {
      const next = lines[i + 1]
      if (next === undefined || next.indent <= indent) throw new FrontmatterError(l.n, "an empty list item")
      const [v, j] = block(lines, i + 1, next.indent)
      out.push(v)
      i = j
    } else if (KEY.test(rest) && !rest.startsWith('"') && !rest.startsWith("'")) {
      // `- key: value`: a map whose first entry sits where the text after the dash starts.
      const inner = indent + (l.text.length - l.text.slice(1).trimStart().length)
      const [v, j] = map([...lines.slice(0, i), { n: l.n, indent: inner, text: rest }, ...lines.slice(i + 1)], i, inner)
      out.push(v)
      i = j
    } else {
      out.push(scalar(rest, l.n))
      i++
    }
  }
  return [out, i]
}

const map = (lines: ReadonlyArray<Line>, start: number, indent: number): [Value, number] => {
  const out: Record<string, Value> = {}
  let i = start
  while (i < lines.length && lines[i]!.indent === indent && !isItem(lines[i]!)) {
    const l = lines[i]!
    const m = KEY.exec(l.text)
    if (m === null) throw new FrontmatterError(l.n, `expected "key: value", got "${l.text}"`)
    const key = m[1]!
    if (key in out) throw new FrontmatterError(l.n, `"${key}" appears twice`)
    const rest = m[2]?.trim() ?? ""
    const next = lines[i + 1]
    if (uncomment(rest) === "" && !rest.startsWith('"') && !rest.startsWith("'") && next !== undefined && (next.indent > indent || (next.indent === indent && isItem(next)))) {
      const [v, j] = block(lines, i + 1, next.indent)
      out[key] = v
      i = j
    } else {
      out[key] = scalar(rest, l.n)
      i++
    }
  }
  return [out, i]
}

/** A Markdown file's frontmatter (empty when it has none) and the Markdown after it. */
export const parse = (markdown: string): { readonly data: { readonly [key: string]: Value }; readonly body: string } => {
  const all = markdown.split("\n")
  if (all[0]?.trimEnd() !== "---") return { data: {}, body: markdown }
  const close = all.findIndex((l, i) => i > 0 && l.trimEnd() === "---")
  if (close < 0) throw new FrontmatterError(1, "the frontmatter never closes with ---")
  const lines: Array<Line> = []
  for (let i = 1; i < close; i++) {
    const raw = all[i]!
    const n = i + 1
    if (/^\s*\t/.test(raw)) throw new FrontmatterError(n, "a tab in the indentation (use spaces)")
    const text = raw.trim()
    if (text === "" || text.startsWith("#")) continue
    lines.push({ n, indent: raw.length - raw.trimStart().length, text: raw.trimEnd().trimStart() })
  }
  const body = all.slice(close + 1).join("\n")
  if (lines.length === 0) return { data: {}, body }
  const [data, j] = map(lines, 0, lines[0]!.indent)
  if (j < lines.length) throw new FrontmatterError(lines[j]!.n, "this line is indented where nothing can hold it")
  return { data: data as { readonly [key: string]: Value }, body }
}

/** A string that reads back as itself when written plain. */
const plain = (s: string) => s !== "" && s === s.trim() && !/^[-"'#[{!&*?|>%@`]/.test(s) && !/:(\s|$)|\s#/.test(s) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) && !s.includes("\n")

const scalarText = (v: Value): string => (typeof v === "string" ? (plain(v) ? v : JSON.stringify(v)) : String(v))

const emit = (v: Value, indent: number): Array<string> => {
  const pad = " ".repeat(indent)
  if (Array.isArray(v))
    return v.flatMap((item: Value) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length > 0) {
        const [first, ...rest] = emit(item, indent + 2)
        return [`${pad}- ${first!.trimStart()}`, ...rest]
      }
      if (Array.isArray(item) && item.length > 0) return [`${pad}-`, ...emit(item, indent + 2)]
      return [`${pad}- ${empty(item) ?? scalarText(item)}`]
    })
  return Object.entries(v as Record<string, Value>).flatMap(([k, x]) => {
    const e = empty(x)
    if (e !== undefined) return [`${pad}${k}: ${e}`]
    if (x !== null && typeof x === "object") return [`${pad}${k}:`, ...emit(x, indent + 2)]
    return [`${pad}${k}: ${scalarText(x)}`]
  })
}
const empty = (v: Value) => (Array.isArray(v) && v.length === 0 ? "[]" : v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0 ? "{}" : undefined)

/** Frontmatter and a body as one Markdown file (what `parse` reads back). */
export const stringify = (data: { readonly [key: string]: Value }, body: string): string => `---\n${emit(data, 0).join("\n")}\n---\n${body}`
