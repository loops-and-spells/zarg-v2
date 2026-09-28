# @zarg/markdown

Embeddable Markdown and Unicode Mermaid rendering for OpenTUI on Bun. Reuses OpenTUI's Markdown renderer, tables, links, syntax highlighting, and streaming. No zarg core or agent runtime is required.

## React

```tsx
import { SyntaxStyle } from "@opentui/core"
import { Markdown } from "@zarg/markdown/react"

const syntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: "#d7dce2" },
  "markup.heading": { fg: "#7aa2f7", bold: true },
})

<Markdown content={message} width={availableColumns} syntaxStyle={syntaxStyle} streaming={receiving} />
```

Supply the content area's width in terminal columns, excluding labels, borders, and padding. Update it when the container resizes. Styles belong to the host; keep the `SyntaxStyle` instance stable and dispose it when the host no longer uses it. Standard OpenTUI Markdown props remain available except `renderNode`, which this component supplies.

Set `streaming` while content arrives, then clear it to finalize parsing. A Mermaid fence stays source until its closing fence arrives. Rendered content determines the component's natural height; use `onSizeChange` when a parent needs that height. The host owns scrolling and layout.

## OpenTUI core

```ts
import { MarkdownRenderable } from "@opentui/core"
import { mermaidRenderer } from "@zarg/markdown"

const markdown = new MarkdownRenderable(renderer, {
  content: message,
  width: availableColumns,
  syntaxStyle,
  renderNode: mermaidRenderer(renderer, { width: availableColumns }),
})
renderer.root.add(markdown)
```

On resize, update `markdown.width` and replace `markdown.renderNode` with a new hook for the available width. Destroy the renderable through the host's normal OpenTUI lifecycle.

## Mermaid coverage

Uses `beautiful-mermaid` text output with a conservative syntax subset. Other syntax stays source rather than being silently discarded by the backend:

- Flowcharts: a separate header line, one statement per line, spaced arrows, simple node labels/shapes, and optional subgraphs. Define labels before referencing nodes.
- States: basic transitions, with descriptions and aliases declared before the transitions.
- Sequences: participants/actors declared first, then `->>` or `-->>` messages with labels.
- Classes: named class declarations and relationships.
- ER: entity relationships with cardinalities and labels.

Incomplete fences, parse failures, unknown types, reverse flow directions (RL/BT), and diagrams wider than the container remain readable source. Widening the container retries rendering. Diagrams never wrap; source can wrap through OpenTUI.

Synchronous diagram layout is limited to 4,096 source characters, 100 fence lines, and, for flow/state graphs, 32 nodes and 64 edges. Larger inputs stay source. Images, SVG rasterization, and complete Mermaid.js syntax compatibility are outside this implementation.

## Checks

From the repository root: `mise //packages/markdown:test` and `mise //packages/markdown:typecheck`.
