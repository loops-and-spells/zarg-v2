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
  /** File names (not paths) directly in a folder the plugin may read. */
  readonly list: (dir: string) => Effect.Effect<ReadonlyArray<string>, PluginFailure>
}>()("@zarg/plugin-sdk/Files") {}
export class Graph extends Context.Service<Graph, { readonly snapshot: Effect.Effect<Snapshot.Snapshot, PluginFailure> }>()("@zarg/plugin-sdk/Graph") {}
export class Config extends Context.Service<Config, { readonly value: unknown }>()("@zarg/plugin-sdk/Config") {}

/** The decision model: fast yes/no, choice and score judgments (scope `decisions: true`). */
export class Decisions extends Context.Service<Decisions, { readonly decide: (req: { readonly state: string; readonly questions: Readonly<Record<string, unknown>> }) => Effect.Effect<Readonly<Record<string, any>>, PluginFailure> }>()("@zarg/plugin-sdk/Decisions") {}
export interface ModelMessage { readonly role: "system" | "user" | "assistant"; readonly content: string }
/** A configured model role (scope `models: [role, …]`); tokens count against the plugin. */
export class Models extends Context.Service<Models, {
  readonly complete: (req: { readonly role: string; readonly messages: ReadonlyArray<ModelMessage>; readonly outputSchema?: Record<string, unknown>; readonly maxTokens?: number }) => Effect.Effect<{ readonly text: string; readonly promptTokens: number; readonly completionTokens: number }, PluginFailure>
}>()("@zarg/plugin-sdk/Models") {}
/** Time and randomness from the host: a plugin's sandbox has neither. */
export class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number, PluginFailure>; readonly uuid: Effect.Effect<string, PluginFailure> }>()("@zarg/plugin-sdk/Clock") {}
/** This plugin's agents in the agents pane (scope `agents: true`): their rows, their history, their end. */
export class Agents extends Context.Service<Agents, {
  readonly start: (a: { readonly id: string; readonly parent?: string; readonly title: string; readonly task: string }) => Effect.Effect<void, PluginFailure>
  readonly status: (a: { readonly id: string; readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }) => Effect.Effect<void, PluginFailure>
  readonly step: (a: { readonly id: string; readonly text: string }) => Effect.Effect<void, PluginFailure>
  readonly end: (a: { readonly id: string; readonly ok: boolean; readonly message?: string }) => Effect.Effect<void, PluginFailure>
}>()("@zarg/plugin-sdk/Agents") {}
/** Tell the host this plugin's agenda changed (the driver may take it up). */
export class Agenda extends Context.Service<Agenda, { readonly changed: Effect.Effect<void, PluginFailure> }>()("@zarg/plugin-sdk/Agenda") {}

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
  files: Files.of({
    read: (path) => power<string>(raw, "fs.read", { path }),
    write: (path, text) => Effect.asVoid(power(raw, "fs.write", { path, text })),
    list: (dir) => power<ReadonlyArray<string>>(raw, "fs.list", { dir }),
  }),
  decisions: Decisions.of({ decide: (req) => power(raw, "decisions.decide", req) }),
  models: Models.of({ complete: (req) => power(raw, "models.complete", req) }),
  clock: Clock.of({ now: power<number>(raw, "clock.now", {}), uuid: power<string>(raw, "clock.uuid", {}) }),
  agenda: Agenda.of({ changed: Effect.asVoid(power(raw, "agenda.changed", {})) }),
  agents: Agents.of({
    start: (a) => Effect.asVoid(power(raw, "agents.event", { event: "start", ...a })),
    status: (a) => Effect.asVoid(power(raw, "agents.event", { event: "status", ...a })),
    step: (a) => Effect.asVoid(power(raw, "agents.event", { event: "step", ...a })),
    end: (a) => Effect.asVoid(power(raw, "agents.event", { event: "end", ...a })),
  }),
  graph: Graph.of({
    snapshot: Effect.map(power<{ nodes: ReadonlyArray<never>; reserved?: ReadonlyArray<string> }>(raw, "graph.snapshot", {}), (s) => Snapshot.make(s.nodes, new Set(s.reserved ?? []))),
  }),
})
