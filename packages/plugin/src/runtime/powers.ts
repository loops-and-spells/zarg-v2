import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Deferred, Effect, Redacted } from "effect"
import type { Grant, Grants, ManifestScopes } from "./grants"
import type { Powers } from "./process"

export type Answer = "once" | "folder" | "always" | "deny"
export type Ask = (q: { readonly plugin: string; readonly what: string; readonly options: ReadonlyArray<{ readonly id: Answer; readonly label: string }> }) => Effect.Effect<Answer>

const ASK_TIMEOUT_MS = 10 * 60_000

export const secretVar = (plugin: string, key: string) => `ZARG_PLUGIN_${plugin.toUpperCase().replaceAll("-", "_")}__${key.toUpperCase().replaceAll("-", "_")}`

const notGranted = (message: string) => Object.assign(new Error(message), { tag: "NotGranted" })

// A glob is a literal prefix plus an optional trailing "/**" (any depth) or "/*" (one level).
const globMatch = (glob: string, path: string) => {
  if (glob.endsWith("/**")) return path === glob.slice(0, -3) || path.startsWith(`${glob.slice(0, -3)}/`)
  if (glob.endsWith("/*")) return dirname(path) === glob.slice(0, -2)
  return path === glob
}
const expandHome = (p: string) => (p.startsWith("~/") ? `${process.env.HOME ?? ""}${p.slice(1)}` : p)

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

export const makePowers = (opts: {
  readonly plugin: string
  readonly manifest: { readonly scopes: ManifestScopes; readonly optional: ManifestScopes }
  readonly grants: Grants
  readonly digest: string
  readonly vault: (name: string) => Effect.Effect<Redacted.Redacted<string> | undefined>
  readonly config: unknown
  readonly snapshot?: () => { readonly nodes: ReadonlyArray<unknown> }
  readonly ask: Ask
  readonly askTimeoutMs?: number
  readonly yolo: () => boolean
  readonly log: (line: string) => void
  readonly redact: (text: string) => string
  readonly fetch?: typeof fetch
}): Powers => {
  const pendingQuestions = new Map<string, Promise<Answer>>()

  /** Allowed when granted; else ask (optional scopes), pass (YOLO) or refuse. */
  const allow = async (kind: Kind, target: string, what: string, folder?: string) => {
    const granted = await Effect.runPromise(opts.grants.of(opts.plugin, opts.digest))
    if (granted.loaded && declared(opts.manifest.scopes, kind, target) === true) return
    if (granted.extra.some((g) => grantMatches(g, kind, target))) return
    const optional = declared(opts.manifest.optional, kind, target)
    if (optional === false) throw notGranted(`${opts.plugin}: ${what} is not declared in its manifest`)
    if (opts.yolo()) return void opts.log(`yolo: ${opts.plugin} ${kind} ${target}`)
    const key = `${kind}\u0000${target}`
    let answer = pendingQuestions.get(key)
    if (answer === undefined) {
      const options = [
        { id: "once" as const, label: "Allow once" },
        ...(folder !== undefined ? [{ id: "folder" as const, label: `Allow ${folder}` }] : []),
        { id: "always" as const, label: "Always allow" },
        { id: "deny" as const, label: "Deny" },
      ]
      answer = Effect.runPromise(
        opts.ask({ plugin: opts.plugin, what, options }).pipe(Effect.timeoutOrElse({ duration: opts.askTimeoutMs ?? ASK_TIMEOUT_MS, orElse: () => Effect.succeed<Answer>("deny") })),
      ).finally(() => pendingQuestions.delete(key))
      pendingQuestions.set(key, answer)
    }
    const a = await answer
    if (a === "deny") throw notGranted(`${opts.plugin}: ${what} was denied`)
    if (a === "always") await Effect.runPromise(opts.grants.add(opts.plugin, (kind === "net" ? { kind, host: target } : kind === "secret" ? { kind, name: target } : { kind, glob: target }) as Grant))
    if (a === "folder" && folder !== undefined) await Effect.runPromise(opts.grants.add(opts.plugin, { kind: kind as "fs-read" | "fs-write", glob: folder }))
  }

  // Open first, then check where the opened file really is: a symlink swapped in after a path check cannot redirect it.
  const checkedPath = async (kind: "fs-read" | "fs-write", raw: string) => {
    const path = resolve(expandHome(raw))
    await allow(kind, path, `${kind === "fs-read" ? "read" : "write"} ${path}`, `${dirname(path)}/**`)
    return path
  }
  const assertSame = (path: string, fd: number) => {
    const real = realpathSync(path)
    const a = fstatSync(fd)
    const b = statSync(real)
    if (a.ino !== b.ino || a.dev !== b.dev || real !== path) throw notGranted(`${opts.plugin}: ${path} resolves outside its grant`)
  }

  const fetchImpl = opts.fetch ?? fetch
  return {
    "config.get": async () => opts.config,
    "console.log": async (line) => void opts.log(`${opts.plugin}: ${opts.redact(String(line))}`),
    "secrets.get": async (args) => {
      const name = String((args as { name?: unknown }).name ?? "")
      if (!/^[A-Z0-9_]+$/i.test(name)) throw notGranted(`${opts.plugin}: "${name}" is not a secret name`)
      await allow("secret", name, `the secret ${name}`)
      const v = await Effect.runPromise(opts.vault(secretVar(opts.plugin, name)))
      if (v === undefined) throw Object.assign(new Error(`${opts.plugin}: secret ${name} is not set`), { tag: "PluginError" })
      return Redacted.value(v)
    },
    fetch: async (args) => {
      const a = args as { url: string; method?: string; headers?: Record<string, string>; body?: string }
      let url = new URL(a.url)
      for (let hop = 0; hop < 5; hop++) {
        if (url.protocol !== "https:") throw notGranted(`${opts.plugin}: only https is allowed (${url.protocol})`)
        await allow("net", url.hostname, `reach ${url.hostname}`)
        const r = await fetchImpl(url.href, { method: a.method ?? "GET", headers: a.headers ?? {}, ...(a.body !== undefined ? { body: a.body } : {}), redirect: "manual" })
        const location = r.headers.get("location")
        if (r.status >= 300 && r.status < 400 && location !== null) { url = new URL(location, url); continue }
        return { status: r.status, headers: Object.fromEntries(r.headers.entries()), text: await r.text() }
      }
      throw Object.assign(new Error(`${opts.plugin}: too many redirects`), { tag: "PluginError" })
    },
    "fs.read": async (args) => {
      const path = await checkedPath("fs-read", String((args as { path: string }).path))
      const fd = openSync(path, "r")
      try { assertSame(path, fd); return readFileSync(fd, "utf8") } finally { closeSync(fd) }
    },
    "fs.write": async (args) => {
      const a = args as { path: string; text: string }
      const path = await checkedPath("fs-write", a.path)
      const fd = openSync(path, "w")
      try { assertSame(path, fd); writeFileSync(fd, String(a.text)) } finally { closeSync(fd) }
      return null
    },
    ...(opts.snapshot !== undefined ? { "graph.snapshot": async () => opts.snapshot!() } : {}),
  }
}
