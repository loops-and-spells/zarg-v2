# Embeddable Markdown and Mermaid rendering feasibility

## Recommendation

Use OpenTUI's existing Markdown renderer and its code-block hook. For a fenced `mermaid` block, call [`beautiful-mermaid`](https://github.com/lukilabs/beautiful-mermaid)'s synchronous `renderMermaidASCII` and return the Unicode text as the custom block. This is the smallest Bun/TypeScript-native path: one MIT package, no DOM/browser, no Rust toolchain, no WASM bridge, and no image protocol. Set `colorMode: "none"` initially so OpenTUI owns styling and width accounting.

This first option treats Mermaid as terminal text. Unsupported, incomplete, or failed diagrams should remain a normal fenced source block. Width is the main integration limit: `beautiful-mermaid` exposes spacing controls but no hard `maxWidth`, so wide diagrams need horizontal scrolling or a source fallback; wrapping the diagram would break its geometry.

OpenTUI already exposes Markdown content, streaming, table options, and `renderNode`/`createMarkdownCodeBlockRenderer` ([source](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderables/Markdown.ts)); these APIs were also verified in the installed package. Zarg's `packages/view/src/schema.ts` already carries `{ markdown: string }`. Before this implementation, the `Text` renderer in `packages/view-tui/src/sections.tsx` displayed that string as plain text, and `wantedOf` estimated height from source lines. Conversations had separate plain-text rendering paths.

The implementation is now in [`@zarg/markdown`](../../packages/markdown/README.md), used by zarg's text sections and agent conversations. Its supported Mermaid subset is deliberately narrower than the upstream engine: integration testing found silently discarded syntax, incorrect reverse directions, and unbounded graph expansion. Unsupported forms remain source, and layout runs only within input/graph limits.

## Options checked

### `beautiful-mermaid` (best fit)

- The published package is TypeScript/ESM, advertises Bun directly in its export map, and depends only on `elkjs` and `entities`; its license is MIT. The package manifest is the primary source: [`package.json`](https://github.com/lukilabs/beautiful-mermaid/blob/main/package.json).
- Its public API is a synchronous `renderMermaidASCII(text, options?): string`, with Unicode or plain ASCII, spacing controls, optional ANSI/HTML colors, and themes. Source and examples: [`src/ascii/index.ts`](https://github.com/lukilabs/beautiful-mermaid/blob/main/src/ascii/index.ts), [`README`](https://github.com/lukilabs/beautiful-mermaid#ascii-output).
- The text renderer supports flowcharts/state, sequence, class, ER, and XY charts. One concrete fidelity limit in current source is that RL flowcharts are laid out as LR; this is a Mermaid subset rather than Mermaid.js compatibility.
- The same package can produce SVG, but OpenTUI's image component does not accept SVG directly. Using SVG would add rasterization plus sizing/cache work, so it is not the first implementation.

### `mermaid-text` (good Rust engine, poor direct integration fit)

- `mermaid-text` is a standalone MIT Rust crate in the `markdown-reader` workspace. Its runtime dependencies are `unicode-width`, `ascii-dag`, and `chrono`; it forbids unsafe code. Manifest: [`Cargo.toml`](https://github.com/leboiko/markdown-reader/blob/master/crates/mermaid-text/Cargo.toml).
- Its simple public entry points return strings: `render`, `render_with_width`, `render_ascii`, `render_ascii_with_width`, and `render_with_options`. `RenderOptions` includes a strict width budget, which is useful for fixed TUI panels. API/source: [`lib.rs`](https://github.com/leboiko/markdown-reader/blob/master/crates/mermaid-text/src/lib.rs), [docs.rs](https://docs.rs/mermaid-text/latest/mermaid_text/).
- It covers materially more text diagram kinds than `beautiful-mermaid` (including pie, Gantt, journey, timeline, git graph, mindmap, quadrant, requirement, Sankey, block, packet, and architecture), but many are intentionally simplified text representations. It also documents partial subgraph direction handling and possible narrow-width overflow.
- Upstream currently ships a Rust library and CLI, not JavaScript/WASM bindings: the crate has no `wasm-bindgen`, N-API, JS, or TS surface in its manifest/source. Compiling it to WASM would therefore require maintaining a wrapper and build/package pipeline. That can be revisited only if the wider diagram coverage or strict-width API proves necessary.

### `markdown-reader` image pipeline (separate, later option)

`markdown-reader` does not use `mermaid-text` to create its rich graphics. It uses [`mermaid-rs-renderer`](https://docs.rs/mermaid-rs-renderer/latest/mermaid_rs_renderer/) to produce SVG, `resvg` to rasterize it, then `ratatui-image` for Kitty/Sixel/iTerm/halfblock display; its own manifest shows those as distinct dependencies ([source](https://github.com/leboiko/markdown-reader/blob/master/Cargo.toml)). The reader also disables graphics inside tmux and falls back to source ([Mermaid documentation](https://github.com/leboiko/markdown-reader#mermaid-diagrams)).

OpenTUI can display PNG/JPEG/WebP/GIF/raw RGBA with Kitty, Sixel, or block fallback, but not SVG ([image formats](https://github.com/anomalyco/opentui/blob/main/packages/core/src/image.ts), [image renderable](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderables/Image.ts)). Matching the Rust reader's image path would therefore mean choosing an SVG renderer, rasterizer, background/caching policy, and sizing behavior. This remains feasible within an embeddable rendering library if graphical diagrams are part of the desired fidelity.

## Decision boundary

Start with `beautiful-mermaid` text rendering in the Markdown code-fence hook. Consider a Rust/WASM wrapper around `mermaid-text` only after real documents require its extra diagram kinds or strict-width failures become common. Add raster images only if users specifically need graphic Mermaid fidelity and accept the extra rendering pipeline.
