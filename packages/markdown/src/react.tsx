import { useRenderer, type MarkdownProps } from "@opentui/react"
import { useMemo } from "react"
import { mermaidRenderer } from "./index"

// @card UX-0075
/** Markdown with Mermaid diagrams, using the host's styles and available width in terminal columns. */
export const Markdown = (props: Omit<MarkdownProps, "renderNode"> & { width: number }) => {
  const ctx = useRenderer()
  const renderNode = useMemo(() => mermaidRenderer(ctx, { width: props.width, ...(props.fg !== undefined ? { fg: props.fg } : {}) }), [ctx, props.width, props.fg])
  return <markdown {...props} renderNode={renderNode} />
}
