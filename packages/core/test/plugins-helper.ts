import { BunServices } from "@effect/platform-bun"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { layer as graphLayer, type Snapshot } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { pluginHostLayer } from "../src/plugins"

/** First-party plugins (the built Gherkin) with a throwaway grants file, never the developer's. */
export const testPlugins = (root: string) => pluginHostLayer({ root, userDir: mkdtempSync(join(tmpdir(), "zt-core-plugins-")) })

/** `affected` asked of those plugins, as the core asks its host. */
export const testAffected = (root: string) => (before: Snapshot.Snapshot, after: Snapshot.Snapshot) =>
  PluginHost.use((h) => h.affected(before, after)).pipe(
    Effect.provide(Layer.provideMerge(testPlugins(root), graphLayer(mkdtempSync(join(tmpdir(), "zt-core-graph-"))))),
    Effect.provide(BunServices.layer),
    Effect.scoped,
  )
