import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { layer as graphLayer, type Snapshot } from "@zarg/graph"
import { makeGrants, scopesDigest } from "@zarg/plugin/runtime"
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

/** Approve the first-party plugins that need a load grant (rehearse) for `project`, in the tests' user dir: tests not about grants start without the question. */
export const grantFirstParty = (project: string) => {
  const m = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "agent-rehearse", "dist", "zarg-plugin.json"), "utf8"))
  const grants = Effect.runSync(makeGrants({ file: join(process.env.ZARG_USER_DIR!, "grants.json"), project }))
  Effect.runSync(grants.approveLoad(m.name, scopesDigest(m.scopes, m.optional, (m.pluginDependencies ?? []).map((d: { name: string }) => d.name))))
}
