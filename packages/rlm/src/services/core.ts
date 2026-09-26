import { existsSync, realpathSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { Effect, Schema } from "effect"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"
import { redact, scrubEnv, type SensitiveValue } from "@zarg/model"
import { isEnvSecretFile, OutOfScope, pathInScope, type Scope, withinRoot } from "../scope"

export interface CoreContext {
  readonly root: string
  readonly scope: Scope
  readonly sensitive: ReadonlyArray<SensitiveValue>
}

const fail = (_tag: string, message: string): ServiceFailure => ({ _tag, message })
const clip = (text: string, max = 32_768) => (text.length <= max ? text : `${text.slice(0, max / 2)}\n… [${text.length - max} characters cut] …\n${text.slice(-max / 2)}`)

/**
 * The real path of `rel`, following symlinks. For a path that does not exist yet (a write),
 * the nearest existing ancestor is resolved and the rest appended.
 */
const realRel = (root: string, rel: string): string => {
  const realRoot = realpathSync(root)
  let dir = join(root, rel)
  const rest: Array<string> = []
  while (!existsSync(dir) && dir !== root) {
    rest.unshift(dir.slice(dirname(dir).length + 1))
    dir = dirname(dir)
  }
  return withinRoot(realRoot, join(realpathSync(dir), ...rest))
}

/** Resolve a path the RLM asked for, enforcing root, scope and the env-file rule on the real (symlink-free) path. */
const check = (ctx: CoreContext, path: string): string => {
  const rel = realRel(ctx.root, withinRoot(ctx.root, path))
  if (isEnvSecretFile(rel)) throw new OutOfScope(`${rel} holds secrets; agents cannot read it`)
  if (!pathInScope(ctx.scope, rel)) throw new OutOfScope(`${rel} is outside this RLM's scope (${(ctx.scope.paths ?? []).join(", ") || "no files"}); hand the work to a child RLM`)
  return rel
}

const resolvePath = (ctx: CoreContext, path: string) =>
  Effect.try({ try: () => check(ctx, path), catch: (e) => fail("OutOfScope", e instanceof Error ? e.message : String(e)) })

const FsRead = {
  read: { doc: "Read a text file (repo-relative path inside your scope).", params: Schema.Struct({ path: Schema.String }), success: Schema.String },
  list: {
    doc: "List files matching a glob, limited to your scope.",
    params: Schema.Struct({ glob: Schema.String }),
    success: Schema.Array(Schema.String),
  },
} as const

export const FsReadDef = defineService("Fs", "Files in your scope (read only).", FsRead)
export const FsDef = defineService("Fs", "Files in your scope.", {
  ...FsRead,
  write: {
    doc: "Write a text file (creates directories). Returns bytes written.",
    params: Schema.Struct({ path: Schema.String, content: Schema.String }),
    success: Schema.Struct({ bytes: Schema.Number }),
  },
})

const fsHandlers = (ctx: CoreContext) => ({
  read: ({ path }: { path: string }) =>
    Effect.flatMap(resolvePath(ctx, path), (rel) =>
      Effect.tryPromise({
        try: () => Bun.file(`${ctx.root}/${rel}`).text(),
        catch: () => fail("NotFound", `${rel} does not exist or is not readable`),
      }),
    ).pipe(Effect.map((t) => clip(redact(t, ctx.sensitive)))),
  list: ({ glob }: { glob: string }) =>
    Effect.promise(async () => {
      const out: Array<string> = []
      for await (const f of new Bun.Glob(glob).scan({ cwd: ctx.root, onlyFiles: true })) {
        if (f.startsWith("node_modules/") || f.includes("/node_modules/")) continue
        try {
          out.push(check(ctx, f))
        } catch {
          // Outside the repo, outside the scope, or an env file: not listed.
        }
        if (out.length >= 2000) break
      }
      return out.sort()
    }),
})

export const fsRead = (ctx: CoreContext): Bound => bind(FsReadDef, fsHandlers(ctx))

export const fs = (ctx: CoreContext): Bound =>
  bind(FsDef, {
    ...fsHandlers(ctx),
    write: ({ path, content }) =>
      Effect.flatMap(resolvePath(ctx, path), (rel) =>
        Effect.tryPromise({
          try: async () => ({ bytes: await Bun.write(`${ctx.root}/${rel}`, content, { createPath: true }) }),
          catch: (e) => fail("WriteFailed", `${rel}: ${e instanceof Error ? e.message : String(e)}`),
        }),
      ),
  })

/** Run a command with a deadline, a scrubbed env and redacted, capped output. */
export const runCommand = (ctx: CoreContext, argv: ReadonlyArray<string>, timeoutMs: number) =>
  Effect.tryPromise({
    try: async (signal) => {
      // setsid puts the command in its own process group, so a timeout kills everything it started;
      // otherwise a forked child keeps the output pipes open and the read never ends.
      const proc = Bun.spawn(["setsid", ...argv], {
        cwd: ctx.root,
        env: scrubEnv(process.env, ctx.sensitive),
        stdout: "pipe",
        stderr: "pipe",
        signal,
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          process.kill(-proc.pid, "SIGKILL")
        } catch {
          proc.kill("SIGKILL")
        }
      }, timeoutMs)
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      clearTimeout(timer)
      return {
        exitCode,
        timedOut,
        stdout: clip(redact(stdout, ctx.sensitive)),
        stderr: clip(redact(stderr, ctx.sensitive)),
      }
    },
    catch: (e) => fail("CommandFailed", e instanceof Error ? e.message : String(e)),
  })

const CommandResult = Schema.Struct({ exitCode: Schema.Number, timedOut: Schema.Boolean, stdout: Schema.String, stderr: Schema.String })

export const ShDef = defineService("Sh", "Shell commands in the repository root.", {
  run: {
    doc: "Run a bash command. Default deadline 120000 ms. Secrets are not in its environment.",
    params: Schema.Struct({ command: Schema.String, timeoutMs: Schema.optionalKey(Schema.Number) }),
    success: CommandResult,
  },
})

export const sh = (ctx: CoreContext): Bound =>
  bind(ShDef, { run: ({ command, timeoutMs }) => runCommand(ctx, ["bash", "-c", command], Math.min(timeoutMs ?? 120_000, 600_000)) })

export const VerifyDef = defineService("Verify", "The repository's verify gate.", {
  run: {
    doc: "Run the gate (typecheck and tests). passed is the verdict; output is the tail of the log.",
    params: Schema.Struct({}),
    success: Schema.Struct({ passed: Schema.Boolean, output: Schema.String }),
  },
})

export const verify = (ctx: CoreContext, command: ReadonlyArray<string> = ["mise", "run", "verify"], timeoutMs = 600_000): Bound =>
  bind(VerifyDef, {
    run: () =>
      Effect.map(runCommand(ctx, command, timeoutMs), (r) => ({
        passed: r.exitCode === 0,
        output: `${r.stdout}\n${r.stderr}`.trim().slice(-8000),
      })),
  })
