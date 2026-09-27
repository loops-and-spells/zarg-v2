import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Redacted } from "effect"
import type { GraphStore } from "@zarg/graph"
import * as E from "./events"
import type { ThreadLog } from "./log"
import { type Answer as GrantAnswer, type Ask, makeGrants, PLUGIN_NAME } from "@zarg/plugin/runtime"
import {
  type AgendaItem,
  type HostOptions,
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
    /** A plugin's agenda changed: the core wakes the driver (set once main exists). */
    readonly setAgendaChanged: (f: (plugin: string) => void) => void
    /** Where plugins' agents go (main's agents pane), set once the log exists. */
    readonly setAgents: (f: (plugin: string, event: unknown) => void) => void
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

const SHA256 = /^[0-9a-f]{64}$/

/**
 * Plugins a project lists (`[plugins.<name>]`) and `zarg plugin add` installed under
 * `<userDir>/plugins/<name>/<sha256>/`. Project config is in the repository, so every listed name is
 * checked: a plugin name (never a path), not a first-party name, installed at a real hash, and its
 * manifest must call itself that name (grants are by name).
 */
export const installedPlugins = (userDir: string, names: ReadonlyArray<string>, firstPartyNames: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const plugins: Array<LoadedPlugin> = []
    const notices: Array<AgendaItem> = []
    const refuse = (name: string, detail: string) =>
      void notices.push({ id: `plugin-listed:${name}`, title: `Plugin ${String(name).slice(0, 60)} listed in .zarg/config.toml was not loaded`, detail, about: [], priority: 1 })
    for (const name of names) {
      if (!PLUGIN_NAME.test(name)) {
        refuse(name, "It is not a plugin name.")
        continue
      }
      if (firstPartyNames.has(name)) {
        refuse(name, `${name} ships with zarg; the listed one is ignored.`)
        continue
      }
      const current = join(userDir, "plugins", name, "current")
      const sha = existsSync(current) ? readFileSync(current, "utf8").trim() : undefined
      if (sha === undefined) {
        notices.push({ id: `plugin-missing:${name}`, title: `Plugin ${name} is not installed`, detail: `The project lists it. Run \`zarg plugin add <source>\` to install it.`, about: [], priority: 1 })
        continue
      }
      if (!SHA256.test(sha)) {
        refuse(name, "Its installed version is damaged; run `zarg plugin add` again.")
        continue
      }
      const plugin = yield* loadPluginDir(join(userDir, "plugins", name, sha)).pipe(Effect.option)
      if (plugin._tag === "None") {
        refuse(name, "Its installed files cannot be read; run `zarg plugin add` again.")
        continue
      }
      if (plugin.value.manifest.name !== name) {
        refuse(name, `It is installed as ${name} but names itself ${plugin.value.manifest.name}.`)
        continue
      }
      plugins.push(plugin.value)
    }
    return { plugins, notices }
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
  /** The decision model and model roles for service plugins. */
  readonly decide?: HostOptions["decide"]
  readonly complete?: HostOptions["complete"]
}): Layer.Layer<PluginHost | PluginControl, PluginConfigError, GraphStore> => {
  const zargRoot = opts.zargRoot ?? ZARG_ROOT
  const userDir = opts.userDir ?? USER_DIR
  let ask: Ask | undefined
  let agendaChanged: (plugin: string) => void = () => {}
  let agents: (plugin: string, event: unknown) => void = () => {}
  const yoloAll = { on: opts.yolo === true }
  const yoloPlugins = new Set<string>()
  const control = PluginControl.of({
    setAsk: (a) => void (ask = a),
    setAgendaChanged: (f) => void (agendaChanged = f),
    setAgents: (f) => void (agents = f),
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
      const theirs = yield* installedPlugins(userDir, opts.listed ?? [], new Set(own.map((p) => p.manifest.name)))
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
        notices: theirs.notices,
        userDir,
        projectRoot: opts.root,
        ...(opts.decide !== undefined ? { decide: opts.decide } : {}),
        ...(opts.complete !== undefined ? { complete: opts.complete } : {}),
        agendaChanged: (plugin) => agendaChanged(plugin),
        agents: (plugin, event) => agents(plugin, event),
        budget: (name) => {
          const b = (opts.pluginConfig?.(name) as { budget?: { decisions_per_hour?: number; tokens_per_hour?: number } } | undefined)?.budget
          return b === undefined ? undefined : { decisionsPerHour: b.decisions_per_hour ?? 20_000, tokensPerHour: b.tokens_per_hour ?? 2_000_000 }
        },
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

/**
 * `/yolo` and `--yolo`: switch it, and tell every client on `main` (the status line shows YOLO), so a TUI
 * attaching later learns it too. Answers whether any plugin is in YOLO now.
 */
export const makeYolo = (log: ThreadLog, control: PluginControl["Service"]["yolo"]) => ({
  set: (on: boolean, plugin?: string) =>
    Effect.gen(function* () {
      control.set(on, plugin)
      const any = control.any()
      yield* log.append("main", E.custom("zarg.yolo", { on: any }))
      return { on: any }
    }),
})

/** A plugin by name: first-party, or installed by `zarg plugin add` (its current version). */
export const findPlugin = (name: string, opts: { readonly zargRoot?: string; readonly userDir?: string } = {}) =>
  Effect.gen(function* () {
    if (!PLUGIN_NAME.test(name)) return yield* Effect.fail(new PluginConfigError(`"${name.slice(0, 60)}" is not a plugin name`))
    const own = yield* firstParty(opts.zargRoot ?? ZARG_ROOT)
    const found = own.find((p) => p.manifest.name === name)
    if (found !== undefined) return found
    const theirs = yield* installedPlugins(opts.userDir ?? USER_DIR, [name], new Set())
    const p = theirs.plugins[0]
    if (p === undefined) return yield* Effect.fail(new PluginConfigError(`no plugin "${name}": ${theirs.notices[0]?.detail ?? "run `zarg plugin add <source>` first"}`))
    return p
  })

