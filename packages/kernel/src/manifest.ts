import { Schema } from "effect"
import type { ServiceDef } from "./service"

const isNumberEncoding = (s: any) =>
  Array.isArray(s?.anyOf) &&
  s.anyOf.length === 2 &&
  s.anyOf.some((x: any) => x.type === "number") &&
  s.anyOf.some((x: any) => x.type === "string" && Array.isArray(x.enum) && x.enum.includes("NaN"))

const key = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k))

/** JSON Schema (as Effect emits it) → a TypeScript type, for the model to read and the checker to enforce. */
export const tsType = (s: any, defs: Record<string, any> = {}, refs: ReadonlySet<string> = new Set()): string => {
  const recur = (x: any) => tsType(x, defs, refs)
  if (s === undefined || s === true || (typeof s === "object" && Object.keys(s).length === 0)) return "unknown"
  if (s.$ref !== undefined) {
    // A recursive schema refers back to itself; the inner occurrence is typed as unknown.
    const name = String(s.$ref).split("/").pop()!
    return refs.has(name) ? "unknown" : tsType(defs[name], defs, new Set([...refs, name]))
  }
  // Effect encodes an empty struct as "anything but null", which TypeScript spells {}.
  if (s.not?.type === "null" && Object.keys(s).length === 1) return "{}"
  if (isNumberEncoding(s)) return "number"
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ")
  if (s.const !== undefined) return JSON.stringify(s.const)
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    return [...new Set((s.anyOf ?? s.oneOf).map(recur))].join(" | ")
  }
  switch (s.type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array":
      return Array.isArray(s.prefixItems)
        ? `readonly [${s.prefixItems.map(recur).join(", ")}]`
        : `ReadonlyArray<${recur(s.items)}>`
    case "object": {
      const props = Object.entries(s.properties ?? {})
      const required = new Set<string>(s.required ?? [])
      const fields = props.map(([k, v]) => `${key(k)}${required.has(k) ? "" : "?"}: ${recur(v)}`)
      if (props.length === 0 && typeof s.additionalProperties === "object") {
        return `Readonly<Record<string, ${recur(s.additionalProperties)}>>`
      }
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`
    }
  }
  return "unknown"
}

const typeOf = (schema: Schema.Top) => {
  const doc = Schema.toJsonSchemaDocument(schema) as { schema: unknown; definitions?: Record<string, unknown> }
  return tsType(doc.schema, doc.definitions ?? {})
}

/** Declarations every cell is checked against: a minimal Effect shape, failures, and console. */
export const PRELUDE = `/** What a service method returns. Use it with yield*: \`const x = yield* Service.method(params)\`. */
interface Eff<A> { [Symbol.iterator](): Generator<unknown, A, unknown> }
/** How a failed service call looks: its tag and a message saying what to fix. */
interface Failure { readonly _tag: string; readonly message: string }
declare const Effect: {
  /** Recover from a failed call: \`yield* Effect.catch(Svc.m(p), (e) => Effect.succeed(null))\`. */
  catch<A, B>(self: Eff<A>, f: (e: Failure) => Eff<B>): Eff<A | B>
  succeed<A>(value: A): Eff<A>
  /** Run calls together: \`yield* Effect.all([a, b], { concurrency: 4 })\`. */
  all<A>(effects: ReadonlyArray<Eff<A>>, options?: { readonly concurrency?: number }): Eff<Array<A>>
}
declare const console: { log(...values: unknown[]): void; error(...values: unknown[]): void }
`

/** TypeScript declarations for a set of services: what the model reads and what cells are typechecked against. */
export const manifest = (services: ReadonlyArray<ServiceDef>): string =>
  PRELUDE +
  services
    .map((svc) =>
      [
        `/** ${svc.doc} */`,
        `declare const ${svc.name}: {`,
        ...Object.entries(svc.methods).map(
          ([m, def]) => `  /** ${def.doc} */\n  ${m}(params: ${typeOf(def.params)}): Eff<${typeOf(def.success)}>`,
        ),
        "}",
      ].join("\n"),
    )
    .join("\n\n") +
  "\n"
