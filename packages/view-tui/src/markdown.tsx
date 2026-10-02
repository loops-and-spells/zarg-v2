import { SyntaxStyle } from "@opentui/core"
import { Markdown } from "@zarg/markdown/react"
import { useMemo } from "react"
import { type ThemeService, useTheme } from "./theme"

/** Markdown's syntax colours from the theme: syntax keys for code, accent for headings and links. */
const syntaxOf = (t: ThemeService) =>
  SyntaxStyle.fromStyles({
    default: { fg: t.value("text").fg },
    "markup.heading": { fg: t.value("accent").fg, bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.link": { fg: t.value("accent").fg, underline: true },
    "markup.raw": { fg: t.value("attention").fg },
    comment: { fg: t.value("comment").fg },
    keyword: { fg: t.value("keyword").fg },
    string: { fg: t.value("string").fg },
    number: { fg: t.value("number").fg },
  })

/** Code zarg highlights itself (its Gherkin): each token kind by its key (an id is a scenario). */
const highlightOf = (t: ThemeService) => ({
  keyword: t.value("keyword").fg,
  id: t.value("scenario").fg,
  comment: t.value("comment").fg,
  title: t.value("text").fg,
  flow: t.value("accent").fg,
  string: t.value("string").fg,
  number: t.value("number").fg,
  persona: t.value("persona").fg,
  journey: t.value("journey").fg,
})

// @scenario S-0076
export const RichText = (p: { content: string; width: number; streaming?: boolean; onHeight?: (height: number) => void }) => {
  const theme = useTheme()
  const syntaxStyle = useMemo(() => syntaxOf(theme), [theme])
  const highlight = useMemo(() => highlightOf(theme), [theme])
  return (
    <Markdown content={p.content} width={Math.max(1, p.width)} syntaxStyle={syntaxStyle} fg={theme.value("text").fg} highlight={highlight} streaming={p.streaming ?? false}
      tableOptions={{ style: "columns", wrapMode: "word" }} onSizeChange={function () { p.onHeight?.(this.height) }} />
  )
}
