import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Redacted } from "effect"
import type { GraphStore } from "@zarg/graph"
import { type Answer as GrantAnswer, type Ask, makeGrants } from "@zarg/plugin/runtime"
import {
  type AgendaItem,
  isFirstParty,
  KNOWN_FIRST_PARTY,
  layer as hostLayer,
  type LoadedPlugin,
  loadPluginDir,
  MANIFEST_FILE,
  PluginConfigError,
  PluginHost,
} from "@zarg/plugin/server"

/** The zarg checkout (or install) this code runs from: first-party plugins live in its `packages/*\/dist`. */
export const ZARG_ROOT = join(import.meta.dir, "../../..")
/** Where grants and installed plugins live; tests point `ZARG_USER_DIR` at a temp directory. */
export const USER_DIR = process.env.ZARG_USER_DIR ?? join(homedir(), ".config", "zarg")

/** What the core changes about plugins while it runs: where grant questions go, and YOLO. */
export class PluginControl extends Context.Service<
  PluginControl,
  {
    /** Grant questions go here once a thread can ask them; until then they are denied. */
    readonly setAsk: (ask: Ask) => void
    readonly yolo: {
      readonly on: (plugin: string) => boolean
      /** On or off for one plugin, or for all when `plugin` is omitted. */
      readonly set: (on: boolean, plugin?: string) => void
      readonly any: () => boolean
    }
  }
>()("@zarg/core/PluginControl") {}

/** zarg's own built plugins: every `packages/<name>/dist` holding a manifest. */
const firstParty = (zargRoot: string) =>
  Effect.gen(function* () {
    const packages = join(zargRoot, "packages")
    const dirs = existsSync(packages) ? readdirSync(packages).map((p) => join(packages, p, "dist")).filter((d) => existsSync(join(d, MANIFEST_FILE))) : []
    return yield* Effect.forEach(dirs, loadPluginDir)
  })

/** Plugins a project lists (`[plugins.<name>]`) and `zarg plugin add` installed under `<userDir>/plugins/<name>/<sha256>/`. */
const installed = (userDir: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const plugins: Array<LoadedPlugin> = []
    const missing: Array<AgendaItem> = []
    for (const name of names) {
      const current = join(userDir, "plugins", name, "current")
      const sha = existsSync(current) ? readFileSync(current, "utf8").trim() : undefined
      if (sha === undefined) {
        missing.push({ id: `plugin-missing:${name}`, title: `Plugin ${name} is not installed`, detail: `The project lists it. Run \`zarg plugin add <source>\` to install it.`, about: [], priority: 1 })
        continue
      }
      plugins.push(yield* loadPluginDir(join(userDir, "plugins", name, sha)))
    }
    return { plugins, missing }
  })

/**
 * The plugin host for a project: first-party plugins plus the ones it lists, each in its own locked process,
 * with grants from `<userDir>/grants.json`. `vault` and `redact` default to none (graph-only CLI commands).
 */
export const pluginHostLayer = (opts: {
  readonly root: string
  readonly listed?: ReadonlyArray<string>
  readonly pluginConfig?: (plugin: string) => unknown
  readonly vault?: (name: string) => Effect.Effect<Redacted.Redacted<string> | undefined>
  readonly redact?: (text: string) => string
  readonly yolo?: boolean
  readonly zargRoot?: string
  readonly userDir?: string
}): Layer.Layer<PluginHost | PluginControl, PluginConfigError, GraphStore> => {
  const zargRoot = opts.zargRoot ?? ZARG_ROOT
  const userDir = opts.userDir ?? USER_DIR
  let ask: Ask | undefined
  const yoloAll = { on: opts.yolo === true }
  const yoloPlugins = new Set<string>()
  const control = PluginControl.of({
    setAsk: (a) => void (ask = a),
    yolo: {
      on: (plugin) => yoloAll.on || yoloPlugins.has(plugin),
      set: (on, plugin) => {
        if (plugin === undefined) {
          yoloAll.on = on
          if (!on) yoloPlugins.clear()
        } else if (on) yoloPlugins.add(plugin)
        else yoloPlugins.delete(plugin)
      },
      any: () => yoloAll.on || yoloPlugins.size > 0,
    },
  })
  const host = Layer.unwrap(
    Effect.gen(function* () {
      const own = yield* firstParty(zargRoot)
      const theirs = yield* installed(userDir, opts.listed ?? [])
      const grants = yield* makeGrants({ file: join(userDir, "grants.json"), project: opts.root })
      const redact = opts.redact ?? ((t: string) => t)
      return hostLayer([...own, ...theirs.plugins], {
        grants,
        vault: opts.vault ?? (() => Effect.succeed(undefined)),
        config: opts.pluginConfig ?? (() => ({})),
        ask: (q) => (ask === undefined ? Effect.succeed<GrantAnswer>("deny") : ask(q)),
        yolo: control.yolo,
        log: (line) => console.error(`zarg-plugin: ${redact(line)}`),
        redact,
        firstParty: (p) => isFirstParty(p, zargRoot, KNOWN_FIRST_PARTY),
        notices: theirs.missing,
      })
    }),
  )
  return Layer.merge(host, Layer.succeed(PluginControl, control))
}

/** A secret for a plugin, from the project's environment (varlock): sensitive values stay Redacted. */
export const vaultFrom = (get: (name: string) => Effect.Effect<string | Redacted.Redacted<string>, unknown>) => (name: string) =>
  get(name).pipe(
    Effect.map((v) => (Redacted.isRedacted(v) ? v : Redacted.make(v))),
    Effect.orElseSucceed(() => undefined),
  )
