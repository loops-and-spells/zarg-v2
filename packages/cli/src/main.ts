#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { CliError, Command } from "effect/unstable/cli"
import { layer as graphLayer } from "@zarg/graph"
import { zarg } from "./commands"
import { writeAll } from "./write"
import { pluginHostLayer } from "@zarg/core/plugins"
import { graphDir, root } from "./root"

// Graph commands run the project's plugins in their own locked processes, like the core (no secrets here).
// A command runs and exits: background plugins (rehearse, the Triage Agent) start only when a command calls them.
const services = Layer.provideMerge(pluginHostLayer({ root, startServices: false }), graphLayer(graphDir)).pipe(
  Layer.provideMerge(BunServices.layer),
)

/** Command failures go to stderr as `{ "error": <tag>, ...fields }` with exit code 1, so agents can act on them. */
const report = (e: unknown) => {
  if (CliError.isCliError(e)) return Effect.fail(e)
  const { _tag, ...fields } = e as { _tag?: string }
  const message = e instanceof Error && e.message !== "" ? { message: e.message } : {}
  return Effect.andThen(
    // Written as is: a runtime's console may colour what it prints (FORCE_COLOR), and JSON must stay JSON.
    Effect.sync(() => writeAll(2, `${JSON.stringify({ error: _tag ?? "Error", ...fields, ...message }, null, 2)}\n`)),
    Effect.sync(() => {
      process.exitCode = 1
    }),
  )
}

Command.run(zarg, { version: "0.0.0" }).pipe(
  Effect.catch(report),
  Effect.provide(services),
  BunRuntime.runMain,
)
