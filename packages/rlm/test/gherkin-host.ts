import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeGrants } from "@zarg/plugin/runtime"
import { layer as hostLayer, type LoadedPlugin, loadPluginDir } from "@zarg/plugin/server"

/** The built Gherkin plugin (`mise run build` in packages/plugin-gherkin), loaded as zarg loads it. */
export const gherkin: LoadedPlugin = Effect.runSync(loadPluginDir(join(import.meta.dir, "../../plugin-gherkin/dist")))

/** A plugin host running the built Gherkin in its own process, with a throwaway grants file. */
export const gherkinHost = () =>
  hostLayer([gherkin], {
    grants: Effect.runSync(makeGrants({ file: join(mkdtempSync(join(tmpdir(), "zt-rlm-grants-")), "grants.json"), project: "/zt/rlm" })),
    vault: () => Effect.succeed(undefined),
    config: () => ({}),
    ask: () => Effect.succeed("deny"),
    yolo: { on: () => false },
    log: () => {},
    redact: (t) => t,
    firstParty: () => true,
  })
