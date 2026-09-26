import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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
    expect(e.message).toBe('no model for role "driver"; set roles.driver in .zarg/config.toml')
  })
})
