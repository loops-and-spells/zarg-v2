import { Context, Data, Effect } from "effect"
import type { DataAt, LogLine, LogPath, SectionPath, ViewDef, ViewSpec } from "@zarg/view"
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
/** Any plugin's data by ref (scope `entities: { read, command }`; a plugin always reaches its own kinds). */
export interface EntityView { readonly ref: string; readonly type: string; readonly id: string; readonly version: string; readonly label: { readonly text: string; readonly tone: string; readonly glyph: string }; readonly data: unknown }
export class Entities extends Context.Service<Entities, {
  readonly get: (ref: string) => Effect.Effect<EntityView, PluginFailure>
  readonly many: (refs: ReadonlyArray<string>) => Effect.Effect<{ readonly entities: ReadonlyArray<EntityView>; readonly failed: ReadonlyArray<{ readonly ref: string; readonly _tag: string; readonly message: string }> }, PluginFailure>
  readonly query: (q: { readonly type: string; readonly where?: Readonly<Record<string, unknown>>; readonly text?: string; readonly limit?: number }) => Effect.Effect<ReadonlyArray<EntityView>, PluginFailure>
  readonly version: (ref: string) => Effect.Effect<string | null, PluginFailure>
  readonly changed: (ref: string) => Effect.Effect<boolean, PluginFailure>
  readonly label: (ref: string) => Effect.Effect<EntityView["label"], PluginFailure>
  readonly context: (ref: string) => Effect.Effect<string, PluginFailure>
  readonly command: (ref: string, name: string, args: unknown) => Effect.Effect<unknown, PluginFailure>
}>()("@zarg/plugin-sdk/Entities") {}
export class Config extends Context.Service<Config, { readonly value: unknown }>()("@zarg/plugin-sdk/Config") {}

/** The decision model: fast yes/no, choice and score judgments (scope `decisions: true`). */
export class Decisions extends Context.Service<Decisions, { readonly decide: (req: { readonly state: string; readonly questions: Readonly<Record<string, unknown>> }) => Effect.Effect<Readonly<Record<string, any>>, PluginFailure> }>()("@zarg/plugin-sdk/Decisions") {}
export interface ModelMessage { readonly role: "system" | "user" | "assistant"; readonly content: string }
/** A configured model role (scope `models: [role, …]`); tokens count against the plugin. */
export class Models extends Context.Service<Models, {
  readonly complete: (req: { readonly role: string; readonly messages: ReadonlyArray<ModelMessage>; readonly outputSchema?: Record<string, unknown>; readonly maxTokens?: number }) => Effect.Effect<{ readonly text: string; readonly promptTokens: number; readonly completionTokens: number; readonly reasoningTokens?: number; readonly finishReason?: string }, PluginFailure>
}>()("@zarg/plugin-sdk/Models") {}
/** Time and randomness from the host: a plugin's sandbox has neither. */
export class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number, PluginFailure>; readonly uuid: Effect.Effect<string, PluginFailure> }>()("@zarg/plugin-sdk/Clock") {}
/** This plugin's agents in the agents pane (scope `agents: true`): their rows, their history, their end. */
export class Agents extends Context.Service<Agents, {
  /** `view`: one of the plugin's declared views (`views` on the plugin); without one the agent's step lines are its view. */
  readonly start: (a: { readonly id: string; readonly parent?: string; readonly title: string; readonly task: string; readonly view?: string }) => Effect.Effect<void, PluginFailure>
  readonly status: (a: { readonly id: string; readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }) => Effect.Effect<void, PluginFailure>
  readonly step: (a: { readonly id: string; readonly text: string }) => Effect.Effect<void, PluginFailure>
  readonly end: (a: { readonly id: string; readonly ok: boolean; readonly message?: string }) => Effect.Effect<void, PluginFailure>
}>()("@zarg/plugin-sdk/Agents") {}
/** Push data into this plugin's agents' views (scope `agents: true`): typed by the view the agent started with. */
export class Views extends Context.Service<Views, {
  readonly set: <S extends ViewSpec, P extends SectionPath<S>>(agent: string, view: ViewDef<S>, path: P, data: DataAt<S, P>) => Effect.Effect<void, PluginFailure>
  readonly append: <S extends ViewSpec, P extends LogPath<S>>(agent: string, view: ViewDef<S>, path: P, lines: ReadonlyArray<LogLine>) => Effect.Effect<void, PluginFailure>
}>()("@zarg/plugin-sdk/Views") {}
/** A surface to show for one of this plugin's agents; `focus` gives it the keys. */
export interface SurfaceOpen {
  readonly surface: string
  readonly agent: string
  readonly focus?: boolean
}
/**
 * Show this plugin's declared surfaces for its agents (scope `agents: true`). Panels open any time; tiles, sheets and
 * popovers only while the plugin handles the operator's call (an action, an answer, a message, a slash command).
 */
export class Surfaces extends Context.Service<Surfaces, {
  readonly open: (s: SurfaceOpen | ReadonlyArray<SurfaceOpen>) => Effect.Effect<void, PluginFailure>
  readonly close: (surface: string, agent: string) => Effect.Effect<void, PluginFailure>
}>()("@zarg/plugin-sdk/Surfaces") {}
/** Ask for the operator's attention on one of this plugin's agents (scope `agents: true`): a ◆ with the reason. */
export class Attention extends Context.Service<Attention, {
  readonly request: (agent: string, reason: string) => Effect.Effect<void, PluginFailure>
  readonly clear: (agent: string) => Effect.Effect<void, PluginFailure>
}>()("@zarg/plugin-sdk/Attention") {}
/** A question an agent asks in its conversation. */
export interface AgentQuestion {
  readonly question: string
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string; readonly why?: string; readonly recommended?: boolean }>
  readonly allowOther?: boolean
}
/**
 * An agent's conversation (its view's `talk` section, kind `conversation`): say something, ask and wait for the
 * operator's answer. What the operator sends reaches the plugin's `message({ agent, text })` method.
 */
export class Conversation extends Context.Service<Conversation, {
  readonly say: (agent: string, text: string) => Effect.Effect<void, PluginFailure>
  readonly ask: (agent: string, q: AgentQuestion) => Effect.Effect<{ readonly choice?: string; readonly other?: string }, PluginFailure>
}>()("@zarg/plugin-sdk/Conversation") {}
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
  surfaces: Surfaces.of({
    open: (s) => Effect.asVoid(power(raw, "agents.event", { event: "open", surfaces: Array.isArray(s) ? s : [s] })),
    close: (surface, agent) => Effect.asVoid(power(raw, "agents.event", { event: "close", surface, id: agent })),
  }),
  attention: Attention.of({
    request: (agent, reason) => Effect.asVoid(power(raw, "agents.event", { event: "attention", id: agent, reason })),
    clear: (agent) => Effect.asVoid(power(raw, "agents.event", { event: "attention", id: agent })),
  }),
  views: Views.of({
    set: (agent, view, path, data) => Effect.asVoid(power(raw, "agents.event", { event: "set", id: agent, view: view.name, section: path, data })),
    append: (agent, view, path, lines) => Effect.asVoid(power(raw, "agents.event", { event: "append", id: agent, view: view.name, section: path, lines })),
  }),
  entities: Entities.of({
    get: (ref) => power(raw, "entities.call", { op: "get", ref }),
    many: (refs) => power(raw, "entities.call", { op: "many", refs }),
    query: (query) => power(raw, "entities.call", { op: "query", query }),
    version: (ref) => power(raw, "entities.call", { op: "version", ref }),
    changed: (ref) => power(raw, "entities.call", { op: "changed", ref }),
    label: (ref) => power(raw, "entities.call", { op: "label", ref }),
    context: (ref) => power(raw, "entities.call", { op: "context", ref }),
    command: (ref, name, args) => power(raw, "entities.call", { op: "command", ref, name, args }),
  }),
  graph: Graph.of({
    snapshot: Effect.map(power<{ nodes: ReadonlyArray<never>; reserved?: ReadonlyArray<string> }>(raw, "graph.snapshot", {}), (s) => Snapshot.make(s.nodes, new Set(s.reserved ?? []))),
  }),
})
