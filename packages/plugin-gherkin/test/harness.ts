import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer } from "effect"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { layer as hostLayer, PluginHost } from "@zarg/plugin/server"
import { gherkin } from "../src/server"

/** Runs `body` with a PluginHost (gherkin only) over a fresh temp graph. */
export const run = <A, E>(body: Effect.Effect<A, E, PluginHost | GraphStore>) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    return yield* body.pipe(Effect.provide(Layer.provideMerge(hostLayer([gherkin]), graphLayer(dir))))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

export const call = (name: string, params: unknown) =>
  PluginHost.use((h) => h.call(`gherkin/${name}`, params))

/** The pricing flow from the design spec. */
export const pricing = Effect.gen(function* () {
  yield* call("add-state", { text: "the visitor is on the home page", entry: true })
  yield* call("add-card", { title: "Visitor opens pricing", when: 'the visitor clicks "Pricing"', arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown" }] })
  yield* call("add-card", { title: "Visitor picks Free", when: "the visitor picks Free", arrives: { text: "the plan picker is shown" }, then: [{ text: "the account form is shown" }] })
  yield* call("add-card", { title: "Visitor picks Pro", when: "the visitor picks Pro", arrives: { id: "S-0002" }, then: [{ text: "the payment form is shown" }] })
  yield* call("add-card", { title: "Payment succeeds", when: "the visitor pays with a valid card", arrives: { id: "S-0004" }, then: [{ id: "S-0003" }, { text: "a receipt is emailed" }] })
  yield* call("add-card", { title: "Payment is declined", when: "the card is declined", arrives: { id: "S-0004" }, then: [{ id: "S-0004" }, { text: "a decline message is shown" }] })
})
