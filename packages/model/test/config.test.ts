import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Redacted } from "effect"
import { Config, layerTest } from "../src"

const setup = (user: string | undefined, project: string | undefined) => {
  const root = mkdtempSync(join(tmpdir(), "zarg-config-"))
  const userDir = join(root, "home")
  const projectDir = join(root, "repo")
  mkdirSync(userDir)
  mkdirSync(join(projectDir, ".zarg"), { recursive: true })
  if (user !== undefined) writeFileSync(join(userDir, "config.toml"), user)
  if (project !== undefined) writeFileSync(join(projectDir, ".zarg", "config.toml"), project)
  return { userDir, projectDir }
}

const envLayer = layerTest({ ZT_URL: "http://router.test/api/v1", ZT_KEY: "zt-secret" }, ["ZT_KEY"])

const load = (user: string | undefined, project: string | undefined) =>
  Effect.runPromise(
    Config.load(setup(user, project)).pipe(Effect.provide(Layer.merge(envLayer, BunServices.layer))),
  )
const fail = (user: string | undefined, project: string | undefined) =>
  Effect.runPromise(
    Effect.flip(Config.load(setup(user, project))).pipe(Effect.provide(Layer.merge(envLayer, BunServices.layer))),
  )

describe("config loader", () => {
  test("no files gives an empty config", async () => {
    expect(await load(undefined, undefined)).toEqual({ providers: {}, roles: {}, extra: {} })
  })

  test("expands ${VAR} and ${VAR:-default}; $${ stays literal", async () => {
    const c = await load(
      '[providers.r]\nbase_url = "${ZT_URL}"\nfallback = "${ZT_MISSING:-http://d.test}"\nliteral = "$${NOT_A_VAR}"\n',
      undefined,
    )
    expect(c.providers.r).toEqual({ base_url: "http://router.test/api/v1", fallback: "http://d.test", literal: "${NOT_A_VAR}" })
  })

  test("a value built from a sensitive variable is Redacted", async () => {
    const c = await load(undefined, '[providers.o]\napi_key = "Bearer ${ZT_KEY}"\n')
    const key = c.providers.o?.api_key
    expect(Redacted.isRedacted(key)).toBe(true)
    expect(Redacted.value(key as Redacted.Redacted<string>)).toBe("Bearer zt-secret")
    expect(String(key)).not.toContain("zt-secret")
  })

  test("project config overrides user config table by table", async () => {
    const c = await load(
      '[roles]\ndriver = "r:small"\nsync = "r:big"\n',
      '[roles]\ndriver = "r:local"\n',
    )
    expect(c.roles).toEqual({ driver: "r:local", sync: "r:big" })
  })

  test("a missing variable without a default names the variable and the key", async () => {
    const e = await fail(undefined, '[providers.o]\napi_key = "${ZT_NOPE}"\n')
    expect(e.message).toBe("providers.o.api_key: ${ZT_NOPE} is not set")
    expect(e.key).toBe("providers.o.api_key")
  })

  test("[reconcile] is passed through for the core", async () => {
    const c = await load(undefined, "[reconcile]\nquiet_ms = 500\n")
    expect(c.extra.reconcile).toEqual({ quiet_ms: 500 })
  })

  test("unknown sections and malformed roles are errors", async () => {
    expect((await fail(undefined, "[nonsense]\na = 1\n")).message).toBe('unknown config section "nonsense"')
    expect((await fail(undefined, '[roles]\ndriver = "no-colon"\n')).key).toBe("roles.driver")
  })

  test("invalid TOML names the file", async () => {
    const e = await fail(undefined, "[roles\n")
    expect(e.file).toContain(".zarg/config.toml")
  })

  test("roleModel explains which key to set", async () => {
    const e = await Effect.runPromise(Effect.flip(Config.roleModel({ providers: {}, roles: {}, extra: {} }, "driver")))
    expect(e.message).toBe('no model for role "driver" (set a default with /models)')
  })
})

const dirs = () => setup(undefined, undefined)
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(e.pipe(Effect.provide(Layer.merge(envLayer, BunServices.layer))) as Effect.Effect<A, E>)

describe("the default model", () => {
  test("a role without its own model uses roles.default; a project's own role wins; keys list only set roles", async () => {
    const d = dirs()
    writeFileSync(join(d.userDir, "config.toml"), '[roles]\ndefault = "zarg-router:big"\n')
    writeFileSync(join(d.projectDir, ".zarg", "config.toml"), '[roles]\ndriver = "zarg-router:small"\n')
    const c = await run(Config.load(d))
    expect([c.roles.driver, c.roles.plan, c.roles.rehearse]).toEqual(["zarg-router:small", "zarg-router:big", "zarg-router:big"])
    expect(Object.keys(c.roles).sort()).toEqual(["default", "driver"])
  })
  test("with no default, an unset role is undefined, and roleModel says to set a default with /models", async () => {
    const c = await run(Config.load(dirs()))
    expect(c.roles.driver).toBeUndefined()
    expect((await Effect.runPromise(Effect.flip(Config.roleModel(c, "driver")))).message).toBe('no model for role "driver" (set a default with /models)')
  })
  test("[plugins] and [agents] load", async () => {
    const d = dirs()
    writeFileSync(join(d.projectDir, ".zarg", "config.toml"), '[agents]\nttl = "off"\n[plugins.triage]\nworkers = 3\n')
    const c = await run(Config.load(d))
    expect(c.extra.agents).toEqual({ ttl: "off" })
  })
  test("reload updates the same config object in place", async () => {
    const d = dirs()
    const c = await run(Config.load(d))
    writeFileSync(join(d.userDir, "config.toml"), '[roles]\ndefault = "zarg-router:big"\n')
    await run(Config.reload(c, d))
    expect(c.roles.driver).toBe("zarg-router:big")
  })
})

describe("the user config writer", () => {
  test("sets roles.default and adds a missing provider section; comments and other content stay; an existing provider section is left alone", async () => {
    const d = dirs()
    const file = join(d.userDir, "config.toml")
    writeFileSync(file, '# my zarg\n[providers.zarg-router]\nbase_url = "${ZARG_ROUTER_URL}"  # local\n\n[roles]\ndefault = "zarg-router:old"\nplan = "zarg-router:p"\n')
    await run(Config.setUserConfig(file, { default: "openrouter:x", provider: { name: "openrouter", settings: { base_url: "${OPENROUTER_URL}", api_key: "${OPENROUTER_API_KEY}" } } }))
    await run(Config.setUserConfig(file, { provider: { name: "zarg-router", settings: { base_url: "${OTHER}" } } }))
    expect(readFileSync(file, "utf8")).toBe(
      '# my zarg\n[providers.zarg-router]\nbase_url = "${ZARG_ROUTER_URL}"  # local\n\n[roles]\ndefault = "openrouter:x"\nplan = "zarg-router:p"\n\n[providers.openrouter]\nbase_url = "${OPENROUTER_URL}"\napi_key = "${OPENROUTER_API_KEY}"\n',
    )
  })
  test("a missing file gets a [roles] section", async () => {
    const d = dirs()
    const file = join(d.userDir, "sub", "config.toml")
    await run(Config.setUserConfig(file, { default: "zarg-router:big" }))
    expect(readFileSync(file, "utf8")).toBe('[roles]\ndefault = "zarg-router:big"\n')
  })
})
