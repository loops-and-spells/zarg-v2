import { CodeRenderable, createMarkdownCodeBlockRenderer, fg, StyledText, TextRenderable, type ColorInput, type MarkdownOptions, type RenderContext } from "@opentui/core"
import { highlight, languages, type Token } from "@zarg/highlight"
import { parseMermaid, renderMermaidASCII } from "beautiful-mermaid"

// The backend consumes prefixes silently. Accept complete basic flowchart statements only;
// richer shapes, parallel links, multiple statements per line, and direction overrides retain source.
const label = String.raw`(?:"[^"\[\](){}\r\n]+"|[^"\[\](){}\r\n]+)`
const shape = String.raw`(?:\(\[${label}\]\)|\(\(${label}\)\)|\[${label}\]|\(${label}\)|\{${label}\})`
const node = String.raw`[\w-]+${shape}?`
const arrow = String.raw`<?(?:-->|---|-\.->|-\.-|==>|===)(?:\|[^|\r\n]*\|)?`
const flowLine = new RegExp(String.raw`^${node}(?:\s+${arrow}\s+${node})*;?$`)
const stateId = String.raw`(?:\[\*\]|[\w\p{L}-]+)`
const stateLine = new RegExp(String.raw`^(?:${stateId}\s+-->\s+${stateId}(?:\s*:\s*.+)?|[\w\p{L}-]+\s*:\s*.+|state\s+"[^"]+"\s+as\s+[\w\p{L}]+)$`, "u")
const sequenceLine = /^(?:(?:participant|actor)\s+\w+(?:\s+as\s+.+)?|\w+\s*(?:->>|-->>)\s*\w+\s*:\s*.+)$/
const classLine = /^(?:class\s+\w+|\w+\s+(?:<\|--|\*--|o--|-->|--|\.\.>|\.\.\|>)\s+\w+(?:\s*:\s*.+)?)$/
const cardinality = String.raw`(?:\|\||\|o|o\||o\{|\}o|\|\{|\}\|)`
const erLine = new RegExp(String.raw`^\w+\s+${cardinality}(?:--|\.\.)${cardinality}\s+\w+\s*:\s*.+$`)
const graphFits = (source: string): boolean => {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("%%"))
  const header = lines[0] ?? ""
  const body = lines.slice(1)
  if (/^sequenceDiagram$/i.test(header)) {
    const firstMessage = body.findIndex((line) => line.includes("->>"))
    return body.every((line) => sequenceLine.test(line)) && !body.slice(Math.max(0, firstMessage)).some((line) => firstMessage >= 0 && /^(?:participant|actor)\b/.test(line))
  }
  if (/^classDiagram$/i.test(header)) return body.every((line) => classLine.test(line))
  if (/^erDiagram$/i.test(header)) return body.every((line) => erLine.test(line))
  if (/^(?:graph|flowchart)\b/i.test(header)) {
    let depth = 0
    const seen = new Set<string>()
    for (const line of body) {
      if (/^subgraph\s+[\w-]+(?:\s*\[[^\[\]]+\])?$/.test(line)) { if (++depth > 4) return false }
      else if (line === "end") { if (--depth < 0) return false }
      else {
        if (!flowLine.test(line)) return false
        for (const match of line.matchAll(new RegExp(String.raw`([\w-]+)(${shape})?`, "g"))) {
          // The backend never updates a node's label after its first reference.
          if (seen.has(match[1]!) && match[2] !== undefined) return false
          seen.add(match[1]!)
        }
      }
    }
    if (depth !== 0) return false
  } else if (/^stateDiagram(?:-v2)?$/i.test(header)) {
    if (body.some((line) => !stateLine.test(line))) return false
    const firstTransition = body.findIndex((line) => line.includes("-->"))
    if (firstTransition >= 0 && body.slice(firstTransition).some((line) => !line.includes("-->"))) return false
  } else return false
  const graph = parseMermaid(source)
  return graph.nodes.size <= 32 && graph.edges.length <= 64
}

// @card C-0077
// @card C-0078
/** Colours for highlighted code blocks, by token kind (the host's theme); a kind without one is plain text. */
export type Highlight = Partial<Record<Token, ColorInput>>

/** A code block in a language `@zarg/highlight` knows, drawn with the host's colours. */
const highlighted = (ctx: RenderContext, lang: string, source: string, options: { fg?: ColorInput; highlight: Highlight }) => {
  const plain = options.fg ?? "#ffffff"
  const chunks = highlight(lang, source).flatMap((line, i) => [
    ...(i > 0 ? [fg(plain)("\n")] : []),
    ...line.map((s) => fg((s.token !== undefined ? options.highlight[s.token] : undefined) ?? plain)(s.text)),
  ])
  // Wrapped by word: a narrow pane (a detail beside a list) must not cut the code off.
  return new TextRenderable(ctx, { content: new StyledText(chunks), wrapMode: "word" })
}

/** An OpenTUI Markdown code-block hook. Recreate it when the available column width changes. */
export const mermaidRenderer = (ctx: RenderContext, options: { width: number; fg?: ColorInput; highlight?: Highlight }): NonNullable<MarkdownOptions["renderNode"]> => {
  const diagram = createMarkdownCodeBlockRenderer({
    // Languages zarg highlights itself (its Gherkin): only when the host gives colours.
    ...(options.highlight === undefined ? {} : Object.fromEntries(Object.keys(languages).map((lang) => [lang, (token: { text: string }) => highlighted(ctx, lang, token.text, { ...(options.fg !== undefined ? { fg: options.fg } : {}), highlight: options.highlight! })]))),
    mermaid: (token) => {
      const lines = token.raw.trimEnd().split(/\r?\n/)
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1]
      // A parser accepts unclosed fences while streaming; only draw a finished diagram.
      if (fence === undefined || lines.length < 2 || !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines.at(-1)!)) return
      // ponytail: synchronous layout is for small diagrams; move larger ones to a worker when needed.
      if (token.text.length > 4096 || lines.length > 100 || options.width < 1) return
      // The backend mishandles reverse directions (including labels in BT). Keep the source faithful.
      if (/^\s*(?:(?:graph|flowchart)\s+(?:RL|BT)\b|direction\s+(?:RL|BT)\b)/im.test(token.text)) return
      try {
        if (!graphFits(token.text)) return
        const content = renderMermaidASCII(token.text, { colorMode: "none", paddingX: 2, paddingY: 1 })
        if (!content.trim() || content.split("\n").some((line) => Bun.stringWidth(line) > options.width)) return
        return new TextRenderable(ctx, { content, wrapMode: "none", ...(options.fg !== undefined ? { fg: options.fg } : {}) })
      } catch {
        // Unknown diagram types and unfinished syntax stay visible through OpenTUI's default code renderer.
        return
      }
    },
  })!
  return (token, context) => {
    const rendered = diagram(token, context) ?? context.defaultRender()
    // Ordinary Markdown must remain visible while the asynchronous highlighter initializes.
    const pending = rendered ? [rendered] : []
    while (pending.length > 0) {
      const node = pending.pop()!
      if (node instanceof CodeRenderable) node.drawUnstyledText = true
      pending.push(...node.getChildren())
    }
    return rendered
  }
}
