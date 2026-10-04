import { Cause, Effect, Redacted } from "effect"
import { defineView, type Layout, layoutOf, type Surface } from "@zarg/view"
import { type Config, type Env, type Model, ModelError, type Provider, type Secrets } from "@zarg/model"

/** The Setup view (agent `core:setup`): providers, the login form, the default model. */
const SetupView = defineView("setup", {
  summary: { kind: "text", role: "summary", title: "" },
  providers: {
    kind: "table",
    role: "primary",
    title: "Providers",
    columns: [{ id: "provider", label: "provider", filter: "none" }, { id: "state", label: "state", filter: "none" }],
    actions: [{ id: "login", label: "Log in", on: "row", default: true }],
  },
  fields: {
    kind: "table",
    role: "primary",
    title: "Log in",
    columns: [{ id: "name", label: "setting", filter: "none" }, { id: "about", label: "", filter: "none" }],
    actions: [
      { id: "set", label: "Set", on: "row", default: true, input: "the value" },
      { id: "done", label: "Check and save", key: "c", on: "none" },
    ],
  },
  models: {
    kind: "table",
    role: "primary",
    title: "Default model",
    search: true,
    columns: [{ id: "model", label: "model", filter: "none" }, { id: "about", label: "", filter: "none" }],
    actions: [{ id: "default", label: "Use as default", on: "row", default: true }],
  },
})
export const SETUP_LAYOUT: Layout = layoutOf(SetupView)
export const SETUP_SURFACE: Surface = { kind: "sheet", name: "setup", view: "setup" }

export interface SetupDeps {
  readonly providers: ReadonlyArray<Provider>
  readonly env: Env["Service"]
  readonly secrets: Secrets.Secrets["Service"]
  /** The live config (reload updates it in place). */
  readonly config: Config.ZargConfig
  readonly reloadConfig: Effect.Effect<void, unknown>
  readonly writeUserConfig: (edit: Parameters<typeof Config.setUserConfig>[1]) => Effect.Effect<void, unknown>
  /** `~/.config/zarg/.env.schema`, so varlock reads the values login writes beside it. */
  readonly ensureUserSchema: Effect.Effect<void, unknown>
  readonly model: Model.Model["Service"]
  readonly agentEvents: (plugin: string, event: unknown) => void
  /** A secret was saved: the log's redactor learns it. */
  readonly secretsChanged: Effect.Effect<void>
}

/** Why a provider does not answer, in the operator's words. */
const why = (e: unknown) => {
  const m = e as { kind?: string; status?: number; message?: string }
  if (m.status === 401 || m.status === 403) return "the key was refused"
  if (m.status === 404) return "check its URL"
  if (m.kind === "transport" || m.kind === "timeout") return "is it running?"
  return String(m.message ?? e).split("\n")[0]!
}
const k = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n))

/** First-run setup: a provider set up (its values saved, then checked), then the default model; the view is the core's own. */
export const makeSetup = (d: SetupDeps) => {
  const AGENT = "setup"
  let started = false
  let selected: string | undefined
  /** A provider's state: not set up, reachable with its models, or why not. */
  const status = (p: Provider) =>
    Effect.gen(function* () {
      if (d.config.providers[p.name] === undefined) return { ok: false as const, text: "◇ not set up" }
      const r = yield* Effect.result(Effect.flatMap(d.model.client(p.name), (c) => c.verify))
      if (r._tag === "Failure") return { ok: false as const, text: `✗ ${why(r.failure)}`, reason: why(r.failure) }
      const models = yield* d.model.list(p.name).pipe(Effect.orElseSucceed(() => []))
      return { ok: true as const, text: `✓ reachable · ${models.length} model${models.length === 1 ? "" : "s"}`, models }
    })
  const set = (section: string, data: unknown) => d.agentEvents("core", { event: "set", id: AGENT, section, data })
  const render = Effect.gen(function* () {
    const states = yield* Effect.forEach(d.providers, (p) => Effect.map(status(p), (s) => ({ p, s })))
    const ready = states.filter((x) => x.s.ok)
    set("summary", { markdown: `${ready.length} provider${ready.length === 1 ? "" : "s"} ready · default: ${d.config.roles.default ?? "none"}${ready.length === 0 ? "\n\nLog in to a provider (⏎ on it), then pick the default model every agent uses." : ""}` })
    set("providers", { rows: states.map(({ p, s }) => ({ id: p.name, cells: { provider: p.name, state: s.text } })) })
    const sel = d.providers.find((p) => p.name === selected)
    const fields = sel === undefined ? [] : yield* d.env.fields(sel.envKeys).pipe(Effect.orElseSucceed(() => []))
    const rows = yield* Effect.forEach(fields, (f) =>
      Effect.map(d.env.lookup(f.name), (v) => ({
        id: f.name,
        cells: { name: f.name, about: `${f.description ?? ""}${f.required ? " (required)" : ""}${v === undefined ? "" : f.sensitive ? " · set" : ""}`.trim() },
        ...(f.sensitive ? { secret: true } : v !== undefined && !Redacted.isRedacted(v) ? { text: v } : {}),
      })),
    )
    set("fields", { rows })
    set("models", { rows: ready.flatMap(({ p, s }) => (s.ok ? s.models.map((m) => ({ id: `${p.name}:${m.id}`, cells: { model: `${p.name}:${m.id}`, about: [m.contextLength > 0 ? k(m.contextLength) : "", ...m.capabilities].filter((x) => x !== "").join(" · ") } })) : [])) })
  })
  const open = (_at?: "providers" | "models") =>
    Effect.gen(function* () {
      if (!started) {
        started = true
        d.agentEvents("core", { event: "start", id: AGENT, title: "setup", task: "Set up a model provider and the default model", view: "setup" })
      }
      yield* render
      d.agentEvents("core", { event: "open", surfaces: [{ surface: "setup", agent: AGENT, focus: true }], gesture: true })
    }).pipe(Effect.catchCause((c) => Effect.sync(() => console.error(`zarg-core: setup could not open: ${String(Cause.squash(c))}`))))
  /** Setup is needed while the driver has no model, or its provider does not answer. */
  const needed = Effect.gen(function* () {
    const ref = d.config.roles.driver
    if (ref === undefined) return true
    const provider = ref.slice(0, ref.indexOf(":"))
    const r = yield* Effect.result(Effect.flatMap(d.model.client(provider), (c) => c.verify))
    return r._tag === "Failure"
  })
  const act = (action: string, rows: ReadonlyArray<string>, text: string | undefined): Effect.Effect<{ readonly notice: string }> =>
    Effect.gen(function* () {
      if (action === "open") {
        yield* open()
        return { notice: "" }
      }
      if (action === "login") {
        selected = rows[0]
        yield* render
        return { notice: selected === undefined ? "pick a provider" : `${selected}: set its values, then c to check and save` }
      }
      if (action === "set") {
        const name = rows[0]
        if (name === undefined || text === undefined || text === "") return { notice: "nothing to save" }
        const [field] = yield* d.env.fields([name])
        yield* d.ensureUserSchema
        yield* field?.sensitive === true ? d.secrets.set(name, Redacted.make(text)) : d.secrets.setPlain(name, text)
        yield* d.secretsChanged
        yield* render
        return { notice: `${name} saved` }
      }
      if (action === "done") {
        const p = d.providers.find((x) => x.name === selected)
        if (p === undefined) return { notice: "pick a provider first" }
        yield* d.writeUserConfig({ provider: { name: p.name, settings: p.settings } })
        yield* d.reloadConfig
        if (d.model.reconnect !== undefined) yield* d.model.reconnect
        const s = yield* status(p)
        yield* render
        return { notice: s.ok ? `${p.name}: reachable, ${s.models.length} model${s.models.length === 1 ? "" : "s"}` : `${p.name}: ${s.text.replace(/^[✗◇] /, "")}` }
      }
      if (action === "default") {
        const ref = rows[0]
        if (ref === undefined) return { notice: "pick a model" }
        yield* d.writeUserConfig({ default: ref })
        yield* d.reloadConfig
        yield* render
        if (!(yield* needed)) d.agentEvents("core", { event: "close", surface: "setup", id: AGENT })
        return { notice: `default model: ${ref}` }
      }
      return { notice: `setup has no action ${action}` }
    }).pipe(Effect.catch((e: unknown) => Effect.succeed({ notice: e instanceof ModelError ? why(e) : String((e as { message?: unknown })?.message ?? e) })))
  return { needed, open, act }
}
