import { Effect, Schema } from "effect"
import { definePlugin } from "@zarg/plugin-sdk"
import { render, type RenderInput } from "./render"

/** Terminal evidence in the catalog: coloured frames as SVG, casts in the asciinema player, text, gifs. */
export default definePlugin({
  name: "evidence-terminal",
  service: "EvidenceTerminal",
  archetype: "service",
  config: Schema.Struct({}),
  scopes: { evidence: true },
  evidence: {
    frame: { label: "terminal frame", files: "text" },
    cast: { label: "terminal recording", files: "text" },
    text: { label: "terminal text", files: "text" },
    gif: { label: "terminal gif", files: "binary" },
  },
  assets: ["node_modules/asciinema-player/dist/bundle/asciinema-player.min.js", "node_modules/asciinema-player/dist/bundle/asciinema-player.css", "assets/cast.js", "assets/terminal.css"],
  methods: {
    renderEvidence: {
      doc: "A terminal medium as catalog HTML, with the assets it needs.",
      params: Schema.Unknown,
      success: Schema.Struct({ html: Schema.String, assets: Schema.Array(Schema.String) }),
    },
  },
  make: Effect.succeed({ renderEvidence: (input: unknown) => Effect.sync(() => render(input as RenderInput)) }),
})
