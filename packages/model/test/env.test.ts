import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { Env, layer, redact, scrubEnv } from "../src"

// Variable names are unique to these tests so a developer's real environment can never override them.
let dir = ""
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zarg-env-"))
  mkdirSync(join(dir, "providers"))
  writeFileSync(
    join(dir, ".env.schema"),
    "# @defaultSensitive=false\n# @import(./providers/)\n# ---\n",
  )
  writeFileSync(
    join(dir, "providers", ".env.schema"),
    [
      "# @defaultSensitive=false",
      "# ---",
      "# the test provider key",
      "# @required @sensitive @type=string(startsWith=zt-)",
      "ZARGTEST_KEY=",
      "# @type=url",
      "ZARGTEST_URL=http://default.test/api",
      "",
    ].join("\n"),
  )
  writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=zt-secret-value\n")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = <A, E>(eff: Effect.Effect<A, E, Env>) => Effect.runPromise(Effect.provide(eff, layer(dir)))

describe("Env (varlock)", () => {
  test("reads values through @import; sensitive values come back Redacted", async () => {
    const out = await run(
      Effect.gen(function* () {
        const env = yield* Env
        return { key: yield* env.get("ZARGTEST_KEY"), url: yield* env.get("ZARGTEST_URL") }
      }),
    )
    expect(Redacted.isRedacted(out.key)).toBe(true)
    expect(Redacted.value(out.key as Redacted.Redacted<string>)).toBe("zt-secret-value")
    expect(out.url).toBe("http://default.test/api")
  })

  test("fields describe the schema items for a login form", async () => {
    const fields = await run(Env.use((e) => e.fields(["ZARGTEST_KEY", "ZARGTEST_URL"])))
    expect(fields.map((f) => [f.name, f.sensitive, f.required, f.errors.length])).toEqual([
      ["ZARGTEST_KEY", true, true, 0],
      ["ZARGTEST_URL", false, true, 0], // varlock: an item with a default counts as required
    ])
    expect(fields[0]?.description).toBe("the test provider key")
  })

  test("an undeclared variable is an EnvError naming it", async () => {
    const err = await run(Effect.flip(Env.use((e) => e.fields(["ZARGTEST_NOPE"]))))
    expect(err.variable).toBe("ZARGTEST_NOPE")
  })

  test("a value that breaks its schema type is reported on the field", async () => {
    writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=wrong-prefix\n")
    const fields = await run(
      Effect.gen(function* () {
        const env = yield* Env
        yield* env.reload
        return yield* env.fields(["ZARGTEST_KEY"])
      }),
    )
    expect(fields[0]?.errors[0]).toContain("zt-")
    writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=zt-secret-value\n")
  })

  test("reload picks up a changed file", async () => {
    const out = await run(
      Effect.gen(function* () {
        const env = yield* Env
        writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=zt-rotated\n")
        yield* env.reload
        return yield* env.get("ZARGTEST_KEY")
      }),
    )
    expect(Redacted.value(out as Redacted.Redacted<string>)).toBe("zt-rotated")
    writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=zt-secret-value\n")
  })
})

describe("leak guard helpers", () => {
  const sensitive = [
    { name: "A_KEY", value: Redacted.make("sk-short") },
    { name: "B_KEY", value: Redacted.make("sk-short-and-longer") },
  ]
  test("redact replaces every occurrence, longest value first", () => {
    expect(redact("x sk-short-and-longer y sk-short z", sensitive)).toBe("x <redacted:B_KEY> y <redacted:A_KEY> z")
  })
  test("scrubEnv drops sensitive variables and keeps the rest", () => {
    expect(scrubEnv({ A_KEY: "sk-short", PATH: "/bin", B_KEY: undefined }, sensitive)).toEqual({ PATH: "/bin" })
  })
})

describe("Env schema errors", () => {
  test("a broken schema fails with varlock's reason, not a generic message", async () => {
    const bad = mkdtempSync(join(tmpdir(), "zarg-env-bad-"))
    writeFileSync(join(bad, "not-dotenv.schema"), "X=1\n")
    writeFileSync(join(bad, ".env.schema"), "# @import(./not-dotenv.schema)\n# ---\n")
    const err = await Effect.runPromise(Effect.flip(Effect.provide(Env.use((e) => e.lookup("X")), layer(bad))))
    expect(err.message).toContain("imported file must be a .env.* file")
    rmSync(bad, { recursive: true, force: true })
  })
})

describe("Env in any project", () => {
  test("a project without .env.schema sees the provider schemas and the user dir's values; the project's own schema still wins", async () => {
    const root = mkdtempSync(join(tmpdir(), "zt-env-any-"))
    const prov = join(root, "prov"), user = join(root, "user"), proj = join(root, "proj"), proj2 = join(root, "proj2")
    for (const d of [prov, user, proj, proj2]) mkdirSync(d, { recursive: true })
    writeFileSync(join(prov, ".env.schema"), "# @defaultSensitive=false\n# ---\n# @type=url\nZTANY_URL=http://default.invalid\n")
    writeFileSync(join(user, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
    writeFileSync(join(user, ".env.local"), "ZTANY_URL=http://user.invalid\n")
    writeFileSync(join(proj2, ".env.schema"), "# @defaultSensitive=false\n# ---\nZTANY_URL=http://project.invalid\n")
    const get = (projectDir: string) => Effect.runPromise(Effect.flatMap(Env, (e) => e.lookup("ZTANY_URL")).pipe(Effect.provide(layer(projectDir, { userDir: user, schemas: [join(prov, ".env.schema")] }))))
    expect(await get(proj)).toBe("http://user.invalid")
    expect(await get(proj2)).toBe("http://project.invalid")
    rmSync(root, { recursive: true, force: true })
  })
  test("no schema anywhere: an empty env, not a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "zt-env-none-"))
    expect(await Effect.runPromise(Effect.flatMap(Env, (e) => e.lookup("ZTANY_NONE")).pipe(Effect.provide(layer(root, {}))))).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })
})
