import { constants, promises as fsp, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { Effect, Redacted } from "effect"
import type { Grant, Grants, ManifestScopes } from "./grants"
import type { Powers } from "./process"

export type Answer = "once" | "folder" | "always" | "deny"
export type Ask = (q: { readonly plugin: string; readonly what: string; readonly options: ReadonlyArray<{ readonly id: Answer; readonly label: string }> }) => Effect.Effect<Answer>

const ASK_TIMEOUT_MS = 10 * 60_000
/** Files larger than this are refused: a plugin cannot make the core read a huge file into memory. */
const READ_MAX_BYTES = 10 * 1024 * 1024

/** A plugin name: kebab-case, no doubled or trailing dash (so namespaces never collide). */
export const PLUGIN_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
/** A secret key: upper-case words joined by single underscores (the namespace separator is a double one). */
export const SECRET_KEY = /^[A-Z0-9]+(_[A-Z0-9]+)*$/

export const secretVar = (plugin: string, key: string) => {
  if (!PLUGIN_NAME.test(plugin)) throw new Error(`"${plugin}" is not a plugin name`)
  if (!SECRET_KEY.test(key)) throw new Error(`"${key}" is not a secret key`)
  return `ZARG_PLUGIN_${plugin.toUpperCase().replaceAll("-", "_")}__${key}`
}

const notGranted = (message: string) => Object.assign(new Error(message), { tag: "NotGranted" })
const pluginError = (message: string) => Object.assign(new Error(message), { tag: "PluginError" })

// A glob is a literal prefix plus an optional trailing "/**" (any depth) or "/*" (one level).
const globMatch = (glob: string, path: string) => {
  if (glob.endsWith("/**")) return path === glob.slice(0, -3) || path.startsWith(`${glob.slice(0, -3)}/`)
  if (glob.endsWith("/*")) return dirname(path) === glob.slice(0, -2)
  return path === glob
}
/** `~/` needs a real home: with none, the glob matches nothing (never the root of the disk). */
const expandHome = (p: string) => {
  if (!p.startsWith("~/")) return p
  const home = process.env.HOME
  return home !== undefined && home.startsWith("/") ? `${home}${p.slice(1)}` : "\u0000no-home"
}

type Kind = "net" | "secret" | "fs-read" | "fs-write"
const declared = (s: ManifestScopes, kind: Kind, target: string): boolean | "ask" => {
  const list = kind === "net" ? s.net : kind === "secret" ? s.secrets : kind === "fs-read" ? s.fs?.read : s.fs?.write
  if (list === "ask") return "ask"
  if (list === undefined) return false
  return kind === "net" || kind === "secret" ? list.includes(target) : list.some((g) => globMatch(expandHome(g), target))
}
const grantMatches = (g: Grant, kind: Kind, target: string) =>
  g.kind === kind && (g.kind === "net" ? g.host === target : g.kind === "secret" ? g.name === target : globMatch(expandHome(g.glob), target))

export const warnings = (scopes: ManifestScopes, optional: ManifestScopes): ReadonlyArray<string> => {
  const hosts = [scopes.net, optional.net].flatMap((n) => (n === undefined ? [] : n === "ask" ? ["any host"] : n))
  const reads = scopes.graph !== undefined || optional.graph !== undefined
  const secrets = (scopes.secrets?.length ?? 0) + (optional.secrets?.length ?? 0) > 0
  const out: Array<string> = []
  if (reads && hosts.length > 0) out.push(`can read your graph and send it to ${hosts.join(", ")}`)
  if (secrets && (scopes.net === "ask" || optional.net === "ask")) out.push("holds a secret and may ask to reach any host")
  return out
}

/**
 * Never reachable, whatever was granted: zarg's own trust state (grants, installed plugins), the project's
 * config, git internals, and files that make tools run code or hold secrets. A grant cannot hand a plugin
 * the keys to other plugins or to the developer's shell. Agents reading outside the repository obey it too.
 */
export const deniedPath = (path: string, userDir: string) => {
  const parts = path.split(sep)
  const name = basename(path)
  return (
    path === userDir ||
    path.startsWith(`${userDir}${sep}`) ||
    parts.includes(".git") ||
    parts.includes(".ssh") ||
    name === "bunfig.toml" ||
    name === ".npmrc" ||
    name.startsWith(".env") ||
    path.endsWith(`${sep}.zarg${sep}config.toml`) ||
    parts.includes("run") && parts[parts.indexOf("run") - 1] === ".zarg"
  )
}

/** Paths and hosts shown in a question: printable text only, so a plugin cannot fake the question. */
const printable = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?").slice(0, 300)

const SERVED = Symbol("served")
/** Every secret value the host handed this plugin: scrubbed from anything the plugin returns. */
export const served = (powers: Powers): ReadonlySet<string> => (powers as unknown as { [SERVED]?: Set<string> })[SERVED] ?? new Set()

/** Own handlers only: a name like "__proto__" or "hasOwnProperty" is not a power. */
export const isPower = (powers: Powers, name: string) => Object.hasOwn(powers, name) && typeof powers[name] === "function"

export const makePowers = (opts: {
  readonly plugin: string
  readonly manifest: { readonly scopes: ManifestScopes; readonly optional: ManifestScopes }
  readonly grants: Grants
  readonly digest: string
  readonly vault: (name: string) => Effect.Effect<Redacted.Redacted<string> | undefined>
  readonly config: unknown
  readonly snapshot?: () => Promise<{ readonly nodes: ReadonlyArray<unknown> }> | { readonly nodes: ReadonlyArray<unknown> }
  readonly ask: Ask
  readonly askTimeoutMs?: number
  readonly yolo: () => boolean
  readonly log: (line: string) => void
  readonly redact: (text: string) => string
  readonly fetch?: typeof fetch
  /** zarg's user directory (grants, installed plugins): never reachable by a plugin. */
  readonly userDir?: string
  /** Told while a question to the developer is open, so the call's deadline can stop. */
  readonly asking?: (open: boolean) => void
}): Powers => {
  const userDir = resolve(opts.userDir ?? join(process.env.HOME ?? homedir(), ".config", "zarg"))
  const servedValues = new Set<string>()
  // One open question per plugin: a plugin cannot queue up questions ahead of the driver's.
  let open: { readonly key: string; readonly answer: Promise<Answer> } | undefined

  const remember = async (kind: Kind, target: string, a: Answer, folder?: string) => {
    if (a === "always") await Effect.runPromise(opts.grants.add(opts.plugin, (kind === "net" ? { kind, host: target } : kind === "secret" ? { kind, name: target } : { kind, glob: target }) as Grant))
    if (a === "folder" && folder !== undefined) await Effect.runPromise(opts.grants.add(opts.plugin, { kind: kind as "fs-read" | "fs-write", glob: folder }))
  }

  /** Allowed when granted; else ask (optional scopes), pass (YOLO) or refuse. */
  const allow = async (kind: Kind, target: string, what: string, folder?: string) => {
    const granted = await Effect.runPromise(opts.grants.of(opts.plugin, opts.digest))
    if (granted.loaded && declared(opts.manifest.scopes, kind, target) === true) return
    if (granted.extra.some((g) => grantMatches(g, kind, target))) return
    const optional = declared(opts.manifest.optional, kind, target)
    if (optional === false) throw notGranted(`${opts.plugin}: ${printable(what)} is not declared in its manifest`)
    if (opts.yolo()) return void opts.log(`yolo: ${opts.plugin} ${kind} ${printable(target)}`)
    const key = `${kind}\u0000${target}`
    if (open !== undefined && open.key !== key) throw notGranted(`${opts.plugin}: another question from this plugin is waiting for the developer`)
    if (open === undefined) {
      const options = [
        { id: "once" as const, label: "Allow once" },
        ...(folder !== undefined ? [{ id: "folder" as const, label: `Allow ${printable(folder)}` }] : []),
        { id: "always" as const, label: "Always allow" },
        { id: "deny" as const, label: "Deny" },
      ]
      opts.asking?.(true)
      const answer = Effect.runPromise(opts.ask({ plugin: opts.plugin, what: printable(what), options })).then(async (a) => {
        // Saved when it comes, even after the call gave up waiting: "always" holds for next time.
        await remember(kind, target, a, folder)
        return a
      })
      const entry = { key, answer }
      open = entry
      void answer.finally(() => {
        if (open === entry) open = undefined
        opts.asking?.(false)
      })
    }
    const a = await Promise.race([open!.answer, new Promise<Answer>((res) => setTimeout(() => res("deny"), opts.askTimeoutMs ?? ASK_TIMEOUT_MS).unref())])
    if (a === "deny") throw notGranted(`${opts.plugin}: ${printable(what)} was denied`)
  }

  const resolvePath = (raw: string) => resolve(expandHome(String(raw)))
  const checkedPath = async (kind: "fs-read" | "fs-write", raw: string) => {
    const path = resolvePath(raw)
    if (deniedPath(path, userDir)) throw notGranted(`${opts.plugin}: ${printable(path)} is never reachable by plugins`)
    await allow(kind, path, `${kind === "fs-read" ? "read" : "write"} ${path}`, `${dirname(path)}/**`)
    // The directory must be what it says: no symlinked parent can move the file outside its grant.
    let dirReal: string
    try {
      dirReal = realpathSync(dirname(path))
    } catch {
      throw pluginError(`${opts.plugin}: ${printable(dirname(path))} does not exist`)
    }
    if (dirReal !== dirname(path)) throw notGranted(`${opts.plugin}: ${printable(path)} resolves outside its grant`)
    return path
  }

  const fetchImpl = opts.fetch ?? fetch
  const powers: Powers = {
    "config.get": async () => opts.config,
    "console.log": async (line) => void opts.log(`${opts.plugin}: ${opts.redact(scrub(String(line)))}`),
    "secrets.get": async (args) => {
      const name = String((args as { name?: unknown }).name ?? "")
      if (!SECRET_KEY.test(name)) throw notGranted(`${opts.plugin}: "${printable(name)}" is not a secret name`)
      await allow("secret", name, `the secret ${name}`)
      const v = await Effect.runPromise(opts.vault(secretVar(opts.plugin, name)))
      if (v === undefined) throw pluginError(`${opts.plugin}: secret ${name} is not set`)
      const value = Redacted.value(v)
      if (value.length >= 4) servedValues.add(value)
      return value
    },
    fetch: async (args) => {
      const a = args as { url: string; method?: string; headers?: Record<string, string>; body?: string }
      let url = new URL(a.url)
      for (let hop = 0; hop < 5; hop++) {
        if (url.protocol !== "https:") throw notGranted(`${opts.plugin}: only https is allowed (${url.protocol})`)
        await allow("net", url.hostname, `reach ${url.hostname}`)
        const r = await fetchImpl(url.href, { method: a.method ?? "GET", headers: a.headers ?? {}, ...(a.body !== undefined ? { body: a.body } : {}), redirect: "manual" })
        const location = r.headers.get("location")
        if (r.status >= 300 && r.status < 400 && location !== null) {
          url = new URL(location, url)
          continue
        }
        return { status: r.status, headers: Object.fromEntries(r.headers.entries()), text: await r.text() }
      }
      throw pluginError(`${opts.plugin}: too many redirects`)
    },
    "fs.read": async (args) => {
      const path = await checkedPath("fs-read", String((args as { path: string }).path))
      // No following a symlink, no blocking on a FIFO: open the path itself, then check what it is.
      const fh = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e) => {
        throw e?.code === "ELOOP" ? notGranted(`${opts.plugin}: ${printable(path)} is a symlink`) : pluginError(`${opts.plugin}: cannot read ${printable(path)}: ${e?.code ?? e}`)
      })
      try {
        const st = await fh.stat()
        if (!st.isFile()) throw pluginError(`${opts.plugin}: ${printable(path)} is not a regular file`)
        if (st.size > READ_MAX_BYTES) throw pluginError(`${opts.plugin}: ${printable(path)} is larger than ${READ_MAX_BYTES / 1024 / 1024} MiB`)
        return await fh.readFile("utf8")
      } finally {
        await fh.close()
      }
    },
    "fs.write": async (args) => {
      const a = args as { path: string; text: string }
      const path = await checkedPath("fs-write", a.path)
      // Never through a symlink, and nothing truncated until the opened file is known to be a regular one.
      const fh = await fsp.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644).catch((e) => {
        throw e?.code === "ELOOP" ? notGranted(`${opts.plugin}: ${printable(path)} is a symlink`) : pluginError(`${opts.plugin}: cannot write ${printable(path)}: ${e?.code ?? e}`)
      })
      try {
        if (!(await fh.stat()).isFile()) throw pluginError(`${opts.plugin}: ${printable(path)} is not a regular file`)
        await fh.truncate(0)
        await fh.writeFile(String(a.text))
      } finally {
        await fh.close()
      }
      return null
    },
    ...(opts.snapshot !== undefined ? { "graph.snapshot": async () => await opts.snapshot!() } : {}),
  }
  function scrub(text: string) {
    let out = text
    for (const v of servedValues) out = out.replaceAll(v, "<redacted:plugin-secret>")
    return out
  }
  Object.defineProperty(powers, SERVED, { value: servedValues, enumerable: false })
  return powers
}
