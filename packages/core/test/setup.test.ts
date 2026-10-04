import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted } from "effect"
import { Config, Env, ModelError, type Provider } from "@zarg/model"
import { makeSetup } from "../src/setup"

// Names unique to these tests: a developer's real environment can never override them.
const KEY = "ZT_SETUP_KEY"
const URL = "ZT_SETUP_URL"
const SECRET = "zt-good-secret-value"

/** A fake world: env values (mutable), secrets that write them, a provider that verifies only the good key, a temp user and project dir. */
const world = (seed: { readonly userConfig?: string; readonly values?: Readonly<Record<string, string>> } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "zt-setup-"))
  const userDir = join(root, "user")
  const projectDir = join(root, "proj")
  mkdirSync(userDir, { recursive: true })
  mkdirSync(join(projectDir, ".zarg"), { recursive: true })
  if (seed.userConfig !== undefined) writeFileSync(join(userDir, "config.toml"), seed.userConfig)
  const values = new Map<string, string>(Object.entries(seed.values ?? {}))
  const sensitiveNames = [KEY]
  const env: Env["Service"] = {
    lookup: (n) => Effect.succeed(values.has(n) ? (sensitiveNames.includes(n) ? Redacted.make(values.get(n)!) : values.get(n)!) : undefined),
    get: (n) => (values.has(n) ? Effect.succeed(values.get(n)!) : Effect.die(`${n} unset`)) as never,
    fields: (names) => Effect.succeed(names.map((name) => ({ name, type: undefined, description: name === KEY ? "the API key" : "the base URL", sensitive: sensitiveNames.includes(name), required: name === KEY, errors: [] }))),
    sensitive: Effect.sync(() => (values.has(KEY) ? [{ name: KEY, value: Redacted.make(values.get(KEY)!) }] : [])),
    reload: Effect.void,
  }
  const secretCalls: Array<string> = []
  const secrets = {
    set: (name: string, v: Redacted.Redacted<string>) => Effect.sync(() => (secretCalls.push(`set ${name}`), void values.set(name, Redacted.value(v)))),
    setPlain: (name: string, v: string) => Effect.sync(() => (secretCalls.push(`plain ${name}`), void values.set(name, v))),
    has: (name: string) => Effect.succeed(values.has(name)),
    remove: (name: string) => Effect.sync(() => void values.delete(name)),
  }
  const provider: Provider = {
    name: "fake",
    envKeys: [KEY, URL],
    schemaFile: "/dev/null",
    settings: { base_url: `\${${URL}}`, api_key: `\${${KEY}}` },
    connect: () => Effect.die("unused"),
  }
  const layer = Layer.merge(Layer.succeed(Env, env), BunServices.layer)
  const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A, E>)
  return { root, userDir, projectDir, values, env, secrets, secretCalls, provider, layer, run }
}

const setupIn = async (w: ReturnType<typeof world>) => {
  const config = await w.run(Config.load({ userDir: w.userDir, projectDir: w.projectDir }))
  const events: Array<Record<string, unknown>> = []
  let refreshed = 0
  const verifyFake = Effect.suspend(() => {
    const key = w.values.get(KEY)
    if (config.providers.fake === undefined) return Effect.fail(new ModelError({ kind: "config", message: 'provider "fake" is not configured' }))
    return key === "good" || key === SECRET ? Effect.void : Effect.fail(new ModelError({ kind: "status", status: 401, message: "401 unauthorized" }))
  })
  const model = {
    client: (name: string) => (name === "fake" ? Effect.map(verifyFake, () => ({ verify: verifyFake, models: Effect.succeed([]) }) as never) : Effect.fail(new ModelError({ kind: "config", message: `no provider "${name}"` }))),
    list: (name: string) => (name === "fake" ? Effect.flatMap(verifyFake, () => Effect.succeed([{ id: "big", contextLength: 131072, maxOutputTokens: undefined, supportsTools: true, reasoningEfforts: [], capabilities: ["tools"], state: undefined }])) : Effect.succeed([])),
    reconnect: Effect.void,
    stream: () => Effect.die("unused"),
    info: () => Effect.die("unused"),
    warm: () => Effect.void,
  } as never
  const userConfig = join(w.userDir, "config.toml")
  const s = makeSetup({
    providers: [w.provider],
    env: w.env,
    secrets: w.secrets as never,
    config,
    reloadConfig: Config.reload(config, { userDir: w.userDir, projectDir: w.projectDir }).pipe(Effect.provide(w.layer)),
    writeUserConfig: (edit) => Config.setUserConfig(userConfig, edit).pipe(Effect.provide(w.layer)),
    ensureUserSchema: Effect.void,
    model,
    agentEvents: (plugin, event) => void events.push({ plugin, ...(event as object) }),
    secretsChanged: Effect.sync(() => void refreshed++),
  })
  return { s, events, config, userConfig, refreshed: () => refreshed }
}
const run = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(e as Effect.Effect<A>)
const sectionData = (events: ReadonlyArray<Record<string, unknown>>, section: string) => events.filter((e) => e.event === "set" && e.section === section).at(-1)?.data as { rows?: ReadonlyArray<{ id: string; cells: Record<string, string>; secret?: boolean }>; markdown?: string } | undefined

describe("first-run setup", () => {
  test("not set up: needed, and open starts the core:setup agent, fills its sections and opens its sheet", async () => {
    const w = world()
    const { s, events } = await setupIn(w)
    expect(await run(s.needed)).toBe(true)
    await run(s.open("providers"))
    expect(events.filter((e) => e.event === "start").map((e) => [e.plugin, e.id, e.view])).toEqual([["core", "setup", "setup"]])
    expect(sectionData(events, "providers")?.rows).toEqual([{ id: "fake", cells: { provider: "fake", state: "◇ not set up" } }])
    expect(events.find((e) => e.event === "open")).toMatchObject({ plugin: "core", surfaces: [{ surface: "setup", agent: "setup", focus: true }] })
  })

  test("login: fields come from the env schema, secret rows marked; set stores a secret with Secrets.set and a URL with setPlain; no value in any notice or event", async () => {
    const w = world()
    const { s, events, refreshed } = await setupIn(w)
    await run(s.open())
    await run(s.act("login", ["fake"], undefined))
    expect(sectionData(events, "fields")?.rows?.map((r) => [r.id, r.secret === true])).toEqual([[KEY, true], [URL, false]])
    const notices = [(await run(s.act("set", [KEY], SECRET))).notice, (await run(s.act("set", [URL], "http://fake.invalid"))).notice]
    expect(notices).toEqual([`${KEY} saved`, `${URL} saved`])
    expect(w.secretCalls).toEqual([`set ${KEY}`, `plain ${URL}`])
    expect(refreshed()).toBe(2)
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })

  test("done with a refused key: the provider says the key was refused; no default; the values stay", async () => {
    const w = world({ values: { [KEY]: "wrong-one", [URL]: "http://fake.invalid" } })
    const { s, events, config } = await setupIn(w)
    await run(s.open())
    await run(s.act("login", ["fake"], undefined))
    expect((await run(s.act("done", [], undefined))).notice).toBe("fake: the key was refused")
    expect(sectionData(events, "providers")?.rows?.[0]?.cells.state).toBe("✗ the key was refused")
    expect(config.roles.default).toBeUndefined()
    expect(w.values.get(KEY)).toBe("wrong-one")
  })

  test("done with a good key, then default: the provider section and roles.default are written, needed is false, the sheet closes", async () => {
    const w = world({ values: { [KEY]: "good", [URL]: "http://fake.invalid" } })
    const { s, events, config, userConfig } = await setupIn(w)
    await run(s.open())
    await run(s.act("login", ["fake"], undefined))
    expect((await run(s.act("done", [], undefined))).notice).toBe("fake: reachable, 1 model")
    expect(sectionData(events, "models")?.rows).toEqual([{ id: "fake:big", cells: { model: "fake:big", about: "128k · tools" } }])
    expect((await run(s.act("default", ["fake:big"], undefined))).notice).toBe("default model: fake:big")
    expect(readFileSync(userConfig, "utf8")).toContain('default = "fake:big"')
    expect(readFileSync(userConfig, "utf8")).toContain("[providers.fake]")
    expect(config.roles.driver).toBe("fake:big")
    expect(await run(s.needed)).toBe(false)
    expect(events.find((e) => e.event === "close")).toMatchObject({ plugin: "core", surface: "setup", id: "setup" })
  })

  test("already set up (a default whose provider verifies): not needed", async () => {
    const w = world({ userConfig: '[providers.fake]\nbase_url = "x"\n[roles]\ndefault = "fake:big"\n', values: { [KEY]: "good" } })
    const { s } = await setupIn(w)
    expect(await run(s.needed)).toBe(false)
  })
})

describe("the Setup view through the core's event path", () => {
  test("its layout is a real Layout: the core's plugin-agent events start it, fill its sections and open its sheet", async () => {
    const { mkdtempSync } = await import("node:fs")
    const { makeLog } = await import("../src/log")
    const { pluginAgents } = await import("../src/plugin-agents")
    const { makeSurfaces } = await import("../src/surfaces")
    const { makePrompts } = await import("../src/prompts")
    const { SETUP_LAYOUT, SETUP_SURFACE } = await import("../src/setup")
    const log = Effect.runSync(makeLog(mkdtempSync(join(tmpdir(), "zt-setup-log-")), (t) => t))
    const ev = pluginAgents(log, "main", (p, v) => (p === "core" && v === "setup" ? SETUP_LAYOUT : undefined), (p, n) => (p === "core" && n === "setup" ? SETUP_SURFACE : undefined), makeSurfaces(log, "main"), makePrompts(log), (p) => (p === "core" ? [SETUP_SURFACE] : [])) as (p: string, e: unknown) => void
    const w = world()
    const config = await w.run(Config.load({ userDir: w.userDir, projectDir: w.projectDir }))
    const s = makeSetup({ providers: [w.provider], env: w.env, secrets: w.secrets as never, config, reloadConfig: Effect.void, writeUserConfig: () => Effect.void, ensureUserSchema: Effect.void, model: { client: () => Effect.fail(new ModelError({ kind: "config", message: "none" })), list: () => Effect.succeed([]) } as never, agentEvents: ev, secretsChanged: Effect.void })
    await run(s.open("providers"))
    // View deltas are batched and flushed on a timer.
    await Bun.sleep(300)
    const text = JSON.stringify(log.all())
    expect(text).toContain("◇ not set up")
    expect(text).toContain('"kind":"sheet","view":"core:setup"')
  })
})
