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
export type Seen = Map<string, unknown> & { opened?: Array<unknown>; closed?: Array<unknown>; log?: Array<{ key: string; data: unknown }>; inbox?: Array<{ id: string; key?: string; state: string; kind: string; title: string; answers?: ReadonlyArray<{ id: string }>; moot?: string }> }

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
      // A recording inbox: posts by key update the same topic; settle makes it moot.
      inbox: (_plugin: string, op: string, args: unknown) =>
        Effect.sync(() => {
          const topics = (seen.inbox ??= [])
          const a = args as { topic?: { key?: string; kind: string; title: string; answers?: ReadonlyArray<{ id: string }> }; id?: string; why?: string }
          if (op === "post") {
            const same = topics.find((t) => t.key !== undefined && t.key === a.topic!.key && t.state === "open")
            if (same !== undefined) return Object.assign(same, a.topic).id
            const t = { id: `T-${String(topics.length + 1).padStart(8, "0")}`, state: "open", ...a.topic! }
            topics.push(t)
            return t.id
          }
          if (op === "settle") {
            const t = topics.find((x) => x.id === a.id)
            if (t !== undefined && t.state === "open") Object.assign(t, { state: "moot", moot: a.why })
            return { notice: "settled" }
          }
          if (op === "list") return topics.filter((t) => t.state === "open").map((t) => ({ id: t.id, ...(t.key !== undefined ? { key: t.key } : {}) }))
          return null
        }),
      redact: (t) => t,
      firstParty: () => true,
      projectRoot: root,
      agents: (_plugin, e) => {
        const ev = e as { event?: string; id?: string; section?: string; data?: unknown; surfaces?: unknown }
        if (ev.event === "set") {
          seen.set(`${ev.id}/${ev.section}`, ev.data)
          ;(seen.log ??= []).push({ key: `${ev.id}/${ev.section}`, data: ev.data })
        }
        if (ev.event === "open") (seen.opened ??= []).push(ev.surfaces)
        if (ev.event === "close") (seen.closed ??= []).push((ev as { surface?: unknown }).surface)
      },
    })
    // YOLO loads plugins that wait only for their grant (the backlog writes files).
    return yield* Effect.andThen(PluginHost.use((h) => h.loadWaiting), body(seen, root)).pipe(Effect.provide(Layer.provideMerge(host, graphLayer(join(root, ".zarg", "graph")))))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

export const gherkin = (name: string, params: unknown) => PluginHost.use((h) => h.call(`gherkin/${name}`, params))
