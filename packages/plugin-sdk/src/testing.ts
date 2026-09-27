import { Effect } from "effect"
import { type Powers, spawnPlugin } from "@zarg/plugin/runtime"
import { buildPlugin } from "./build"

/** Build a plugin and run it in the real locked runtime with the given powers (for plugin tests). */
export const testPlugin = (entry: string, powers: Powers) =>
  Effect.flatMap(Effect.promise(() => buildPlugin(entry)), (r) =>
    r.ok ? spawnPlugin({ name: r.manifest.name, bundle: r.bundle, powers }) : Effect.die(new Error(r.errors.join("\n"))),
  )
