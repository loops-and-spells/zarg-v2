import { dirname, join } from "node:path"
import { Context, Effect, FileSystem, Layer, Path, Redacted } from "effect"
import { Env } from "./env"
import { SecretError } from "./errors"

export class Secrets extends Context.Service<
  Secrets,
  {
    /** Encrypt with varlock's device-bound encryption and store as `NAME=varlock("local:...")`. */
    readonly set: (name: string, value: Redacted.Redacted<string>) => Effect.Effect<void, SecretError>
    /** Store a non-sensitive value as plain text (e.g. a base URL entered at login). */
    readonly setPlain: (name: string, value: string) => Effect.Effect<void, SecretError>
    readonly has: (name: string) => Effect.Effect<boolean, SecretError>
    readonly remove: (name: string) => Effect.Effect<void, SecretError>
  }
>()("@zarg/model/Secrets") {}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const varlockCli = join(dirname(Bun.resolveSync("varlock/package.json", import.meta.dir)), "bin", "cli.js")

// @scenario S-0027
/** `echo value | varlock encrypt` → `varlock("local:...")`. The value only travels over stdin. */
const encrypt = (name: string, value: Redacted.Redacted<string>) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([process.execPath, varlockCli, "encrypt"], {
        stdin: new TextEncoder().encode(Redacted.value(value)),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      const ref = /varlock\("local:[^"]+"\)/.exec(out)?.[0]
      if (code !== 0 || ref === undefined) throw new Error(`varlock encrypt exited with ${code}`)
      return ref
    },
    catch: (e) => new SecretError({ message: `could not encrypt ${name}: ${e instanceof Error ? e.message : String(e)}`, name }),
  })

/** Secrets live in `<userDir>/.env.local`, one `NAME=...` line each. */
export const layer = (userDir: string): Layer.Layer<Secrets, never, Env | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const env = yield* Env
      const file = path.join(userDir, ".env.local")
      const io = (e: { message: string }) => new SecretError({ message: `${file}: ${e.message}` })

      const readLines = Effect.gen(function* () {
        const exists = yield* fs.exists(file).pipe(Effect.mapError(io))
        if (!exists) return [] as Array<string>
        return (yield* fs.readFileString(file).pipe(Effect.mapError(io))).split("\n").filter((l) => l.length > 0)
      })
      const writeLines = (lines: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(userDir, { recursive: true }).pipe(Effect.mapError(io))
          const tmp = `${file}.${process.pid}.tmp`
          yield* fs.writeFileString(tmp, lines.map((l) => `${l}\n`).join(""), { mode: 0o600 }).pipe(Effect.mapError(io))
          yield* fs.rename(tmp, file).pipe(Effect.mapError(io))
        })
      const checkName = (name: string) =>
        NAME.test(name) ? Effect.void : Effect.fail(new SecretError({ message: `invalid variable name "${name}"`, name }))
      const upsert = (name: string, rhs: string) =>
        Effect.gen(function* () {
          const lines = (yield* readLines).filter((l) => !l.startsWith(`${name}=`))
          yield* writeLines([...lines, `${name}=${rhs}`])
          yield* env.reload.pipe(Effect.mapError((e) => new SecretError({ message: e.message, name })))
        })

      return {
        set: (name, value) =>
          Effect.flatMap(checkName(name), () => Effect.flatMap(encrypt(name, value), (ref) => upsert(name, ref))),
        setPlain: (name, value) =>
          Effect.flatMap(checkName(name), () =>
            /[\n\r]/.test(value)
              ? Effect.fail(new SecretError({ message: `${name}: value must be one line`, name }))
              : upsert(name, value),
          ),
        has: (name) => Effect.map(readLines, (lines) => lines.some((l) => l.startsWith(`${name}=`))),
        remove: (name) =>
          Effect.gen(function* () {
            const lines = yield* readLines
            yield* writeLines(lines.filter((l) => !l.startsWith(`${name}=`)))
            yield* env.reload.pipe(Effect.mapError((e) => new SecretError({ message: e.message, name })))
          }),
      }
    }),
  )
