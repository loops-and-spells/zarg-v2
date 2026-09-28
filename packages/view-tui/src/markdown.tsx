import { SyntaxStyle } from "@opentui/core"
import { Markdown } from "@zarg/markdown/react"
import { THEME } from "@zarg/view"

const syntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: THEME.text },
  "markup.heading": { fg: THEME.accent, bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.link": { fg: THEME.accent, underline: true },
  "markup.raw": { fg: THEME.attention },
  comment: { fg: THEME.dim },
  keyword: { fg: THEME.accent },
  string: { fg: THEME.ok },
  number: { fg: THEME.attention },
})

/** Code zarg highlights itself (its Gherkin): each token kind in a theme colour. */
const highlight = { keyword: THEME.accent, id: THEME.attention, comment: THEME.dim, title: THEME.text, flow: THEME.accent, string: THEME.ok, number: THEME.attention, persona: THEME.accent, journey: THEME.ok }

// @card UX-0076
export const RichText = (p: { content: string; width: number; streaming?: boolean; onHeight?: (height: number) => void }) => (
  <Markdown content={p.content} width={Math.max(1, p.width)} syntaxStyle={syntaxStyle} fg={THEME.text} highlight={highlight} streaming={p.streaming ?? false}
    tableOptions={{ style: "columns", wrapMode: "word" }} onSizeChange={function () { p.onHeight?.(this.height) }} />
)
