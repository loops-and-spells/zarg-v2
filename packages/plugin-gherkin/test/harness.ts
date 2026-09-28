import { BunServices } from "@effect/platform-bun"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { makeGrants } from "@zarg/plugin/runtime"
import { layer as hostLayer, type LoadedPlugin, PluginHost } from "@zarg/plugin/server"
import { buildPlugin } from "@zarg/plugin-sdk/tools"

// Built once per test file: the plugin runs in its own locked process, as in zarg.
let built: Promise<LoadedPlugin> | undefined
const gherkin = () =>
  (built ??= buildPlugin(join(import.meta.dir, "../src/index.ts")).then((r) => {
    if (!r.ok) throw new Error(r.errors.join("\n"))
    return { manifest: r.manifest as never, bundle: r.bundle, origin: join(import.meta.dir, "..") }
  }))

/** Runs `body` with a PluginHost (gherkin only) over a fresh temp graph. */
export const run = <A, E>(body: Effect.Effect<A, E, PluginHost | GraphStore>) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    const plugin = yield* Effect.promise(gherkin)
    const grants = yield* makeGrants({ file: join(mkdtempSync(join(tmpdir(), "zt-gherkin-")), "grants.json"), project: dir })
    const host = hostLayer([plugin], {
      grants,
      vault: () => Effect.succeed(undefined),
      config: () => ({}),
      ask: () => Effect.succeed("deny"),
      yolo: { on: () => false },
      log: () => {},
      redact: (t) => t,
      firstParty: () => true,
    })
    return yield* body.pipe(Effect.provide(Layer.provideMerge(host, graphLayer(dir))))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

export const call = (name: string, params: unknown) =>
  PluginHost.use((h) => h.call(`gherkin/${name}`, params))

/** The pricing flow from the design spec. */
export const pricing = Effect.gen(function* () {
  yield* call("add-persona", { name: "Visitor", kind: "human", text: "Someone choosing a plan on the website." })
  yield* call("add-state", { text: "the visitor is on the home page", entry: true })
  yield* call("add-card", { title: "Visitor opens pricing", when: 'the visitor clicks "Pricing"', by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown" }] })
  yield* call("add-card", { title: "Visitor picks Free", when: "the visitor picks Free", by: [{ id: "P-0001" }], arrives: { text: "the plan picker is shown" }, then: [{ text: "the account form is shown" }] })
  yield* call("add-card", { title: "Visitor picks Pro", when: "the visitor picks Pro", by: [{ id: "P-0001" }], arrives: { id: "S-0002" }, then: [{ text: "the payment form is shown" }] })
  yield* call("add-card", { title: "Payment succeeds", when: "the visitor pays with a valid card", by: [{ id: "P-0001" }], arrives: { id: "S-0004" }, then: [{ id: "S-0003" }, { text: "a receipt is emailed" }] })
  yield* call("add-card", { title: "Payment is declined", when: "the card is declined", by: [{ id: "P-0001" }], arrives: { id: "S-0004" }, then: [{ id: "S-0004" }, { text: "a decline message is shown" }] })
})
