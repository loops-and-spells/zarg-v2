import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"
import { redact, scrubEnv, type SensitiveValue } from "@zarg/model"
import { isEnvSecretFile, OutOfScope, pathInScope, type Scope, withinRoot } from "../scope"

export interface CoreContext {
  readonly root: string
  readonly scope: Scope
  readonly sensitive: ReadonlyArray<SensitiveValue>
  /**
   * Reads outside the repository (an absolute or `~/` path): allowed only when this says so for the real
   * path (the host asks the operator). Without it, nothing outside the repository is readable.
   */
  readonly outside?: (path: string) => Effect.Effect<void, ServiceFailure>
}

const fail = (_tag: string, message: string): ServiceFailure => ({ _tag, message })
const clip = (text: string, max = 32_768) => (text.length <= max ? text : `${text.slice(0, max / 2)}\n… [${text.length - max} characters cut] …\n${text.slice(-max / 2)}`)
/** Terminal colour and cursor codes: noise to a model and to the operator reading a finding. */
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

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
const check = (ctx: CoreContext, path: string, readOnly = false): string => {
  const rel = realRel(ctx.root, withinRoot(ctx.root, path))
  if (isEnvSecretFile(rel)) throw new OutOfScope(`${rel} holds secrets; agents cannot read it`)
  // Read-only and given no paths (a driver, a research agent): the whole repository.
  if (readOnly && ctx.scope.paths === undefined) return rel
  if (!pathInScope(ctx.scope, rel)) throw new OutOfScope(`${rel} is outside this RLM's scope (${(ctx.scope.paths ?? []).join(", ") || "no files"}); hand the work to a child RLM`)
  return rel
}

const resolvePath = (ctx: CoreContext, path: string, readOnly = false) =>
  Effect.try({ try: () => check(ctx, path, readOnly), catch: (e) => fail("OutOfScope", e instanceof Error ? e.message : String(e)) })

const expandHome = (p: string) => (p.startsWith("~/") && process.env.HOME !== undefined ? `${process.env.HOME}${p.slice(1)}` : p)

/** An absolute (or `~/`) path outside the repository, when outside reads are possible; else undefined. */
const outsideOf = (ctx: CoreContext, path: string): string | undefined => {
  if (ctx.outside === undefined || !(isAbsolute(path) || path.startsWith("~/"))) return undefined
  const abs = resolve(expandHome(path))
  const rel = relative(realpathSync(ctx.root), existsSync(abs) ? realpathSync(abs) : abs)
  return rel.startsWith("..") || isAbsolute(rel) ? abs : undefined
}

/** The real path of an outside path, once the host allows it. */
const allowOutside = (ctx: CoreContext, abs: string) =>
  Effect.gen(function* () {
    const real = yield* Effect.try({ try: () => realpathSync(abs), catch: () => fail("NotFound", `${abs} does not exist`) })
    if (isEnvSecretFile(real)) return yield* Effect.fail(fail("OutOfScope", `${real} holds secrets; agents cannot read it`))
    yield* ctx.outside!(real)
    return real
  })

// Where a glob's fixed part ends: the folder a listing is allowed for.
const globBase = (glob: string) => {
  const parts = glob.split("/")
  const at = parts.findIndex((p) => /[*?[{]/.test(p))
  if (at < 0) return { base: dirname(glob), pattern: parts.at(-1)! }
  // "/**" is rooted at /; "**/x" is the repository (relative), never /.
  return { base: at === 0 ? "." : parts.slice(0, at).join("/") || "/", pattern: parts.slice(at).join("/") }
}

// A folder the process cannot read (or the like) ends a listing: say so to the cell, never crash it.
const listFailed = (glob: string) => (e: unknown) => fail("ListFailed", `${glob}: ${e instanceof Error ? e.message : String(e)}; narrow the glob`)

const FsRead = {
  read: { doc: "Read a text file: a repo-relative path inside your scope, or an absolute or ~/ path outside the repository (the operator is asked first).", params: Schema.Struct({ path: Schema.String }), success: Schema.String },
  list: {
    doc: "List files matching a glob, limited to your scope; an absolute or ~/ glob lists outside the repository (the operator is asked first).",
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
  edit: {
    doc: "Change part of a text file: `old` (exact text, found exactly once) becomes `new`. Easier than rewriting a large file. Returns bytes written.",
    params: Schema.Struct({ path: Schema.String, old: Schema.String, new: Schema.String }),
    success: Schema.Struct({ bytes: Schema.Number }),
  },
})

/** `text` with `old` replaced by `next`, when `old` occurs exactly once; else why not. */
export const editOnce = (text: string, old: string, next: string): { readonly text: string } | { readonly problem: string } => {
  if (old === "") return { problem: "old is empty: say which text to change (or Fs.write the whole file)" }
  const count = text.split(old).length - 1
  if (count === 0) return { problem: "old is not in the file: copy it exactly from Fs.read, whitespace included" }
  if (count > 1) return { problem: `old occurs ${count} times: include more of its surrounding lines so it is found once` }
  return { text: text.replace(old, () => next) }
}

const fsHandlers = (ctx: CoreContext, readOnly = false) => ({
  read: ({ path }: { path: string }) => {
    const outside = outsideOf(ctx, path)
    const file =
      outside !== undefined
        ? allowOutside(ctx, outside)
        : Effect.map(resolvePath(ctx, path, readOnly), (rel) => `${ctx.root}/${rel}`)
    return Effect.flatMap(file, (f) =>
      Effect.tryPromise({
        try: () => Bun.file(f).text(),
        catch: () => fail("NotFound", `${path} does not exist or is not readable`),
      }),
    ).pipe(Effect.map((t) => clip(redact(t, ctx.sensitive))))
  },
  list: ({ glob }: { glob: string }) => {
    const { base, pattern } = globBase(expandHome(glob))
    const outside = outsideOf(ctx, base)
    if (outside !== undefined)
      return Effect.flatMap(allowOutside(ctx, outside), (real) =>
        Effect.tryPromise({ catch: listFailed(glob), try: async () => {
          const out: Array<string> = []
          for await (const f of new Bun.Glob(pattern).scan({ cwd: real, onlyFiles: true })) {
            if (f.split("/").some((p) => p === "node_modules" || p === ".git") || isEnvSecretFile(f)) continue
            out.push(join(real, f))
            if (out.length >= 2000) break
          }
          return out.sort()
        } }),
      )
    return Effect.tryPromise({ catch: listFailed(glob), try: async () => {
      const out: Array<string> = []
      for await (const f of new Bun.Glob(glob).scan({ cwd: ctx.root, onlyFiles: true })) {
        if (f.startsWith("node_modules/") || f.includes("/node_modules/")) continue
        try {
          out.push(check(ctx, f, readOnly))
        } catch {
          // Outside the repo, outside the scope, or an env file: not listed.
        }
        if (out.length >= 2000) break
      }
      return out.sort()
    } })
  },
})

export const fsRead = (ctx: CoreContext): Bound => bind(FsReadDef, fsHandlers(ctx, true))

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
    // An implementer looked for a way to change part of an 11k file and, finding none, read until its budget ran out.
    edit: ({ path, old, new: next }) =>
      Effect.flatMap(resolvePath(ctx, path), (rel) =>
        Effect.flatMap(
          Effect.tryPromise({ try: () => Bun.file(`${ctx.root}/${rel}`).text(), catch: () => fail("NotFound", `${rel} does not exist or is not readable`) }),
          (text) => {
            const r = editOnce(text, old, next)
            return "problem" in r
              ? Effect.fail(fail("EditFailed", `${rel}: ${r.problem}`))
              : Effect.tryPromise({ try: async () => ({ bytes: await Bun.write(`${ctx.root}/${rel}`, r.text) }), catch: (e) => fail("WriteFailed", `${rel}: ${e instanceof Error ? e.message : String(e)}`) })
          },
        ),
      ),
  })

/** Run a command with a deadline, a scrubbed env and redacted, capped output. */
// @scenario S-0045 S-0047
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
      // Interrupted (a stop): take down everything the command started, not only the command itself.
      signal.addEventListener("abort", () => {
        try {
          process.kill(-proc.pid, "SIGKILL")
        } catch {}
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
        stdout: clip(redact(stripAnsi(stdout), ctx.sensitive)),
        stderr: clip(redact(stripAnsi(stderr), ctx.sensitive)),
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

/**
 * Starting, stopping or removing containers belongs to the operator: an implementer once started a database from its
 * worktree (a stack named after the worktree, holding the operator's port) after the operator's own was gone.
 */
const SERVICES = /\b(docker(-compose)?|podman(-compose)?)\s+(compose\s+)?(up|down|start|stop|restart|kill|rm|run|create)\b/
export const servicesRefusal = (command: string) =>
  SERVICES.test(command)
    ? "Starting, stopping or removing containers is the operator's: say which service must run (and how) in your result, or block on it; never start one yourself."
    : undefined

export const sh = (ctx: CoreContext): Bound =>
  bind(ShDef, {
    run: ({ command, timeoutMs }) => {
      const refused = servicesRefusal(command)
      return refused !== undefined ? Effect.fail(fail("ServicesAreTheOperators", refused)) : runCommand(ctx, ["bash", "-c", command], Math.min(timeoutMs ?? 120_000, 600_000))
    },
  })

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
