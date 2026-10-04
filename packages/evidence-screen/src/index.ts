import { Effect, Schema } from "effect"
import { definePlugin } from "@zarg/plugin-sdk"
import { render, type RenderInput } from "./render"

/** Screen evidence in the catalog, from any runner on any platform: screenshots, gifs, video, and traces as timelines. */
export default definePlugin({
  name: "evidence-screen",
  service: "EvidenceScreen",
  archetype: "service",
  config: Schema.Struct({}),
  scopes: { evidence: true },
  evidence: {
    screenshot: { label: "screenshot", files: "binary" },
    gif: { label: "animation", files: "binary" },
    video: { label: "video", files: "binary" },
    trace: { label: "trace", files: "binary" },
  },
  assets: ["assets/screen.css", "assets/trace.js"],
  methods: {
    renderEvidence: {
      doc: "A screen medium as catalog HTML, with the assets it needs.",
      params: Schema.Unknown,
      success: Schema.Struct({ html: Schema.String, assets: Schema.Array(Schema.String) }),
    },
  },
  make: Effect.succeed({ renderEvidence: (input: unknown) => Effect.sync(() => render(input as RenderInput)) }),
})
