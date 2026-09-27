import { Context, Data, Effect } from "effect"
import { Snapshot } from "@zarg/graph/pure"

export class PluginFailure extends Data.TaggedError("PluginFailure")<{ readonly tag: string; readonly message: string }> {}

/** What the runner hands a plugin: one function that asks the host for a power. */
export interface RawPowers { readonly call: (power: string, args: unknown) => Promise<unknown> }

const power = <A>(raw: RawPowers, name: string, args: unknown) =>
  Effect.tryPromise({
    try: () => raw.call(name, args) as Promise<A>,
    catch: (e) => new PluginFailure({ tag: String((e as { tag?: string }).tag ?? "PluginError"), message: String((e as Error).message ?? e) }),
  })

export class Secrets extends Context.Service<Secrets, { readonly get: (name: string) => Effect.Effect<string, PluginFailure> }>()("@zarg/plugin-sdk/Secrets") {}
export interface HttpResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly text: string }
export class Http extends Context.Service<Http, {
  readonly request: (url: string, init?: { readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }) => Effect.Effect<HttpResponse, PluginFailure>
  readonly getJson: (url: string, opts?: { readonly bearer?: string }) => Effect.Effect<any, PluginFailure>
}>()("@zarg/plugin-sdk/Http") {}
export class Files extends Context.Service<Files, {
  readonly read: (path: string) => Effect.Effect<string, PluginFailure>
  readonly write: (path: string, text: string) => Effect.Effect<void, PluginFailure>
}>()("@zarg/plugin-sdk/Files") {}
export class Graph extends Context.Service<Graph, { readonly snapshot: Effect.Effect<Snapshot.Snapshot, PluginFailure> }>()("@zarg/plugin-sdk/Graph") {}
export class Config extends Context.Service<Config, { readonly value: unknown }>()("@zarg/plugin-sdk/Config") {}

/** Every power as an Effect service over the runner's channel. The host decides what is granted. */
export const servicesFrom = (raw: RawPowers) => ({
  secrets: Secrets.of({ get: (name) => power<string>(raw, "secrets.get", { name }) }),
  http: Http.of({
    request: (url, init) => power<HttpResponse>(raw, "fetch", { url, ...init }),
    getJson: (url, opts) =>
      Effect.flatMap(power<HttpResponse>(raw, "fetch", { url, headers: opts?.bearer ? { authorization: `Bearer ${opts.bearer}` } : {} }), (r) =>
        Effect.try({ try: () => JSON.parse(r.text), catch: () => new PluginFailure({ tag: "PluginError", message: `${url}: response is not JSON` }) }),
      ),
  }),
  files: Files.of({ read: (path) => power<string>(raw, "fs.read", { path }), write: (path, text) => Effect.asVoid(power(raw, "fs.write", { path, text })) }),
  graph: Graph.of({
    snapshot: Effect.map(power<{ nodes: ReadonlyArray<never>; reserved?: ReadonlyArray<string> }>(raw, "graph.snapshot", {}), (s) => Snapshot.make(s.nodes, new Set(s.reserved ?? []))),
  }),
})
