import { BunServices } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Redacted } from "effect"
import { Env, layer as envLayer, Secrets } from "../src"

// A project whose schema imports a fake user dir. Unique variable names keep the real environment out.
let root = ""
let userDir = ""
let projectDir = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "zarg-secrets-"))
  userDir = join(root, "home", ".zarg")
  projectDir = join(root, "repo")
  mkdirSync(userDir, { recursive: true })
  mkdirSync(join(projectDir, "providers"), { recursive: true })
  writeFileSync(
    join(projectDir, ".env.schema"),
    `# @defaultSensitive=false\n# @import(./providers/)\n# @import(${userDir}/, allowMissing=true)\n# ---\n`,
  )
  writeFileSync(
    join(projectDir, "providers", ".env.schema"),
    "# @defaultSensitive=false\n# ---\n# @sensitive\nZTS_KEY=\nZTS_URL=\n",
  )
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = <A, E>(eff: Effect.Effect<A, E, Env | Secrets.Secrets>) => {
  const base = Layer.merge(envLayer(projectDir), BunServices.layer)
  return Effect.runPromise(Effect.provide(eff, Layer.provideMerge(Secrets.layer(userDir), base)))
}

describe("Secrets", () => {
  // @scenario S-0027
  test("set encrypts on this device; the file never holds the plaintext; Env reads it back", async () => {
    const value = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets.Secrets
        yield* secrets.set("ZTS_KEY", Redacted.make("zts-plaintext-value"))
        return yield* (yield* Env).get("ZTS_KEY")
      }),
    )
    const file = readFileSync(join(userDir, ".env.local"), "utf8")
    expect(file).toMatch(/^ZTS_KEY=varlock\("local:[^"]+"\)\n$/)
    expect(file).not.toContain("zts-plaintext-value")
    expect(Redacted.value(value as Redacted.Redacted<string>)).toBe("zts-plaintext-value")
  }, 20_000)

  test("setPlain stores a plain value and replaces an earlier one", async () => {
    const url = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets.Secrets
        yield* secrets.setPlain("ZTS_URL", "http://a.test")
        yield* secrets.setPlain("ZTS_URL", "http://b.test")
        return yield* (yield* Env).get("ZTS_URL")
      }),
    )
    expect(url).toBe("http://b.test")
    expect(readFileSync(join(userDir, ".env.local"), "utf8").match(/ZTS_URL=/g)?.length).toBe(1)
  })

  test("remove deletes the line; has reflects it", async () => {
    const out = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets.Secrets
        const before = yield* secrets.has("ZTS_URL")
        yield* secrets.remove("ZTS_URL")
        return { before, after: yield* secrets.has("ZTS_URL"), value: yield* (yield* Env).lookup("ZTS_URL") }
      }),
    )
    expect(out).toEqual({ before: true, after: false, value: undefined })
  })

  test("invalid names and multi-line plain values are refused", async () => {
    const errs = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets.Secrets
        const a = yield* Effect.flip(secrets.setPlain("BAD NAME", "x"))
        const b = yield* Effect.flip(secrets.setPlain("ZTS_URL", "a\nEVIL=1"))
        return [a.message, b.message]
      }),
    )
    expect(errs).toEqual(['invalid variable name "BAD NAME"', "ZTS_URL: value must be one line"])
  })
})
