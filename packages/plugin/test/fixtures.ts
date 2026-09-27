import { BunServices } from "@effect/platform-bun"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import { layer as graphLayer } from "@zarg/graph"
import { buildPlugin } from "@zarg/plugin-sdk/tools"
import { makeGrants } from "../src/runtime"
import { type HostOptions, layer as hostLayer, type LoadedPlugin, PluginHost } from "../src/server"

/** A hand-written bundle in the runner's contract: module.exports.default.serve(powers) → methods. */
export const bundle = (methods: string) => `module.exports.default = { serve: (powers) => (${methods}) }`
export const echo = bundle(`{ echo: async (p) => p, add: async ({ a, b }) => a + b, secret: async ({ key }) => powers.call("secrets.get", { name: key }) }`)
export const looping = bundle(`{ spin: async () => { for (;;) {} }, ok: async () => "ok" }`)
export const crashing = bundle(`{ boom: async () => { throw new Error("plugin failed on purpose") } }`)

/** A plugin built from inline source (written under test/fixtures/.gen so it resolves the workspace's packages). */
export const fixturePlugin = async (source: string): Promise<LoadedPlugin> => {
  const dir = join(import.meta.dir, "fixtures", ".gen", createHash("sha1").update(source).digest("hex").slice(0, 12))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "index.ts"), source)
  const r = await buildPlugin(join(dir, "index.ts"))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  return { manifest: r.manifest as never, bundle: r.bundle, origin: dir }
}

export const hostOptions = (extra: Partial<HostOptions> = {}): HostOptions => ({
  grants: Effect.runSync(makeGrants({ file: join(mkdtempSync(join(tmpdir(), "zt-host-")), "grants.json"), project: "/zt/project" })),
  vault: () => Effect.succeed(undefined),
  config: () => ({}),
  ask: () => Effect.succeed("deny"),
  yolo: { on: () => false },
  log: () => {},
  redact: (t) => t,
  firstParty: () => true,
  ...extra,
})

/** Run `body` against a host of these plugins over a fresh graph. */
export const hostWith = <A, E>(plugins: ReadonlyArray<LoadedPlugin>, body: (h: PluginHost["Service"]) => Effect.Effect<A, E>, extra: Partial<HostOptions> = {}) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    return yield* PluginHost.use(body).pipe(Effect.provide(Layer.provideMerge(hostLayer(plugins, hostOptions(extra)), graphLayer(dir))))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
