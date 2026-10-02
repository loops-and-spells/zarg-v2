import { useRenderer, type MarkdownProps } from "@opentui/react"
import { useMemo } from "react"
import { type Highlight, mermaidRenderer } from "./index"

// @card C-0075
/** Markdown with Mermaid diagrams, using the host's styles and available width in terminal columns. */
export const Markdown = ({ highlight, ...props }: Omit<MarkdownProps, "renderNode"> & { width: number; highlight?: Highlight }) => {
  const ctx = useRenderer()
  const renderNode = useMemo(() => mermaidRenderer(ctx, { width: props.width, ...(props.fg !== undefined ? { fg: props.fg } : {}), ...(highlight !== undefined ? { highlight } : {}) }), [ctx, props.width, props.fg, highlight])
  return <markdown {...props} renderNode={renderNode} />
}
