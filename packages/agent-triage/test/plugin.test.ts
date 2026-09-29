import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import { layer as graphLayer } from "@zarg/graph"
import { makeGrants } from "@zarg/plugin/runtime"
import { layer as hostLayer, type LoadedPlugin, PluginHost } from "@zarg/plugin/server"
import { buildPlugin } from "@zarg/plugin-sdk/tools"

const build = async (pkg: string): Promise<LoadedPlugin> => {
  const r = await buildPlugin(join(import.meta.dir, `../../${pkg}/src/index.ts`))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  return { manifest: r.manifest as never, bundle: r.bundle, origin: join(import.meta.dir, `../../${pkg}`) }
}

test("the Triage Agent loads through the host with gherkin, the backlog and rehearse; a tick with no stages does nothing", async () => {
  const plugins = await Promise.all(["plugin-gherkin", "plugin-backlog", "agent-rehearse", "agent-triage"].map(build))
  const out = await Effect.gen(function* () {
    const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    const grants = yield* makeGrants({ file: join(mkdtempSync(join(tmpdir(), "zt-triage-")), "grants.json"), project: root })
    const seen = new Map<string, unknown>()
    const host = hostLayer(plugins, {
      agents: (_plugin, e) => {
        const ev = e as { event?: string; id?: string; section?: string; data?: unknown }
        if (ev.event === "set") seen.set(`${ev.id}/${ev.section}`, ev.data)
      },
      grants,
      vault: () => Effect.succeed(undefined),
      config: () => ({}),
      ask: () => Effect.succeed("deny"),
      yolo: { on: () => true },
      log: () => {},
      redact: (t) => t,
      firstParty: () => true,
      projectRoot: root,
    })
    return yield* Effect.gen(function* () {
      const h = yield* PluginHost
      yield* h.loadWaiting
      const tick = yield* h.invoke("triage", "tick", {})
      return { names: h.manifests.map((m) => m.name), tick, summary: (seen.get("triage/summary") as { markdown?: string } | undefined)?.markdown }
    }).pipe(Effect.provide(Layer.provideMerge(host, graphLayer(join(root, ".zarg/graph")))))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)
  expect(out.names).toEqual(expect.arrayContaining(["gherkin", "backlog", "rehearse", "triage"]))
  expect(out.tick).toBeNull()
  // Its view is drawn after each tick: idle, with nothing to do.
  expect(out.summary).toContain("**idle**")
}, 60_000)
