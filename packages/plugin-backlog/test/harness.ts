import { BunServices } from "@effect/platform-bun"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { makeGrants } from "@zarg/plugin/runtime"
import { layer as hostLayer, type LoadedPlugin, PluginHost } from "@zarg/plugin/server"
import { buildPlugin } from "@zarg/plugin-sdk/tools"

const build = (entry: string, origin: string) =>
  buildPlugin(entry).then((r) => {
    if (!r.ok) throw new Error(r.errors.join("\n"))
    return { manifest: r.manifest as never, bundle: r.bundle, origin } satisfies LoadedPlugin
  })
let built: Promise<ReadonlyArray<LoadedPlugin>> | undefined
const plugins = () =>
  (built ??= Promise.all([
    build(join(import.meta.dir, "../../plugin-gherkin/src/index.ts"), join(import.meta.dir, "../../plugin-gherkin")),
    build(join(import.meta.dir, "../src/index.ts"), join(import.meta.dir, "..")),
  ]))

/** What the plugins pushed to their views: the last data per view section. */
export type Seen = Map<string, unknown>

/** Runs `body` with gherkin and backlog over a fresh graph in a fresh project folder (YOLO: no grant prompts). */
export const run = <A, E>(body: (seen: Seen, root: string) => Effect.Effect<A, E, PluginHost | GraphStore>) =>
  Effect.gen(function* () {
    const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    const ps = yield* Effect.promise(plugins)
    const grants = yield* makeGrants({ file: join(mkdtempSync(join(tmpdir(), "zt-backlog-")), "grants.json"), project: root })
    const seen: Seen = new Map()
    const host = hostLayer(ps, {
      grants,
      vault: () => Effect.succeed(undefined),
      config: () => ({}),
      ask: () => Effect.succeed("deny"),
      yolo: { on: () => true },
      log: () => {},
      redact: (t) => t,
      firstParty: () => true,
      projectRoot: root,
      agents: (_plugin, e) => {
        const ev = e as { event?: string; id?: string; section?: string; data?: unknown }
        if (ev.event === "set") seen.set(`${ev.id}/${ev.section}`, ev.data)
      },
    })
    // YOLO loads plugins that wait only for their grant (the backlog writes files).
    return yield* Effect.andThen(PluginHost.use((h) => h.loadWaiting), body(seen, root)).pipe(Effect.provide(Layer.provideMerge(host, graphLayer(join(root, ".zarg", "graph")))))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

export const gherkin = (name: string, params: unknown) => PluginHost.use((h) => h.call(`gherkin/${name}`, params))
