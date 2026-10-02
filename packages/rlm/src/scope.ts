import { isAbsolute, normalize, relative, resolve } from "node:path"

/** The bounded domain an RLM may see and touch. */
export interface Scope {
  /** Graph focus: node ids and how many hops around them. */
  readonly graph?: { readonly focus: ReadonlyArray<string>; readonly k: number }
  /** Globs relative to the repo root, e.g. ["packages/graph/**"]. Empty or absent: nothing on disk. */
  readonly paths?: ReadonlyArray<string>
  /** What kind of work this is (a classification), shown to the model. */
  readonly kind?: string
}

export class OutOfScope extends Error {
  readonly _tag = "OutOfScope"
}

/** Resolve `path` inside `root`, refusing anything that escapes it. Returns the repo-relative path. */
export const withinRoot = (root: string, path: string): string => {
  const abs = isAbsolute(path) ? normalize(path) : resolve(root, path)
  const rel = relative(root, abs)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new OutOfScope(`${path} is outside the repository`)
  return rel
}

/** True when a repo-relative path matches one of the scope's globs. */
export const pathInScope = (scope: Scope, rel: string): boolean =>
  (scope.paths ?? []).some((g) => new Bun.Glob(g).match(rel))

/** Env files hold secrets; only the schema is readable. */
// @card C-0046
export const isEnvSecretFile = (rel: string): boolean => {
  const base = rel.split("/").pop() ?? ""
  return base.startsWith(".env") && base !== ".env.schema"
}

/** One line for the prompt: what this RLM may touch. */
export const describeScope = (scope: Scope): string =>
  [
    scope.kind ? `kind: ${scope.kind}` : undefined,
    scope.graph ? `graph: within ${scope.graph.k} hops of ${scope.graph.focus.join(", ")}` : "graph: whole graph",
    scope.paths && scope.paths.length > 0 ? `files: ${scope.paths.join(", ")}` : "files: none",
  ]
    .filter((x) => x !== undefined)
    .join("; ")
