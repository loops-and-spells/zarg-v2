import { TextRenderable, createCliRenderer } from "@opentui/core"

/** Placeholder shell until phase 3 builds the real client. */
export const runTui = async () => {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  renderer.root.add(new TextRenderable(renderer, { content: "zarg" }))
}
