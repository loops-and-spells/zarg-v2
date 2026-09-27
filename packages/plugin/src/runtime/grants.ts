import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Semaphore } from "effect"

export interface ManifestScopes {
  readonly net?: ReadonlyArray<string> | "ask"
  readonly secrets?: ReadonlyArray<string>
  readonly graph?: "read" | "write"
  readonly fs?: { readonly read?: ReadonlyArray<string> | "ask"; readonly write?: ReadonlyArray<string> | "ask" }
  readonly decisions?: boolean
  readonly models?: ReadonlyArray<string>
  readonly agents?: boolean
}
export type Grant =
  | { readonly kind: "net"; readonly host: string }
  | { readonly kind: "secret"; readonly name: string }
  | { readonly kind: "fs-read"; readonly glob: string }
  | { readonly kind: "fs-write"; readonly glob: string }
export interface Granted { readonly loaded: boolean; readonly extra: ReadonlyArray<Grant> }
export interface Grants {
  readonly of: (plugin: string, digest: string) => Effect.Effect<Granted>
  readonly approveLoad: (plugin: string, digest: string) => Effect.Effect<void>
  readonly add: (plugin: string, grant: Grant) => Effect.Effect<void>
}

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v)

export const scopesDigest = (scopes: ManifestScopes, optional: ManifestScopes) => createHash("sha256").update(canonical({ scopes, optional })).digest("hex")

type File = { readonly [project: string]: { readonly [plugin: string]: { readonly digests?: ReadonlyArray<string>; readonly extra?: ReadonlyArray<Grant> } } }

/** `~/.config/zarg/grants.json`: approvals per project and plugin. Never in a repository. */
export const makeGrants = (opts: { readonly file: string; readonly project: string }) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    const read = (): File => { try { return JSON.parse(readFileSync(opts.file, "utf8")) as File } catch { return {} } }
    const write = (f: File) => {
      mkdirSync(dirname(opts.file), { recursive: true })
      const tmp = `${opts.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, opts.file)
    }
    const update = (plugin: string, f: (e: { digests?: ReadonlyArray<string>; extra?: ReadonlyArray<Grant> }) => { digests?: ReadonlyArray<string>; extra?: ReadonlyArray<Grant> }) =>
      Semaphore.withPermits(lock, 1)(Effect.sync(() => {
        const all = read()
        const project = all[opts.project] ?? {}
        write({ ...all, [opts.project]: { ...project, [plugin]: f(project[plugin] ?? {}) } })
      }))
    return {
      of: (plugin, digest) => Effect.sync(() => {
        const e = read()[opts.project]?.[plugin]
        return { loaded: e?.digests?.includes(digest) === true, extra: e?.extra ?? [] }
      }),
      approveLoad: (plugin, digest) => update(plugin, (e) => ({ ...e, digests: [...new Set([...(e.digests ?? []), digest])] })),
      add: (plugin, grant) => update(plugin, (e) => ({ ...e, extra: [...(e.extra ?? []).filter((g) => canonical(g) !== canonical(grant)), grant] })),
    } satisfies Grants
  })
