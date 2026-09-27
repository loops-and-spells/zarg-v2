import { Schema } from "effect"
import type { ServiceDef } from "./service"

const isNumberEncoding = (s: any) =>
  Array.isArray(s?.anyOf) &&
  s.anyOf.length === 2 &&
  s.anyOf.some((x: any) => x.type === "number") &&
  s.anyOf.some((x: any) => x.type === "string" && Array.isArray(x.enum) && x.enum.includes("NaN"))

const key = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k))

const comment = (text: string) => text.replace(/\s+/g, " ").replaceAll("*/", "*\\/")

/**
 * JSON Schema (as Effect emits it) → a TypeScript type, for the model to read and the checker to enforce.
 * A field's `description` annotation becomes a doc comment above it, and its object is laid out one field per
 * line (`indent` is where the type starts). Objects without descriptions stay on one line: this text is in
 * every prompt.
 */
export const tsType = (s: any, defs: Record<string, any> = {}, refs: ReadonlySet<string> = new Set(), indent = ""): string => {
  const recur = (x: any) => tsType(x, defs, refs, indent)
  if (s === undefined || s === true || (typeof s === "object" && Object.keys(s).length === 0)) return "unknown"
  if (s.$ref !== undefined) {
    // A recursive schema refers back to itself; the inner occurrence is typed as unknown.
    const name = String(s.$ref).split("/").pop()!
    return refs.has(name) ? "unknown" : tsType(defs[name], defs, new Set([...refs, name]), indent)
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
      if (props.length === 0 && typeof s.additionalProperties === "object") {
        return `Readonly<Record<string, ${recur(s.additionalProperties)}>>`
      }
      if (props.length === 0) return "{}"
      const inner = `${indent}  `
      const fields = props.map(([k, v]: [string, any]) => ({
        doc: typeof v?.description === "string" ? v.description : undefined,
        decl: `${key(k)}${required.has(k) ? "" : "?"}: ${tsType(v, defs, refs, inner)}`,
      }))
      const inline = `{ ${fields.map((f) => f.decl).join("; ")} }`
      if (fields.every((f) => f.doc === undefined) && !inline.includes("\n")) return inline
      return `{\n${fields.map((f) => `${f.doc !== undefined ? `${inner}/** ${comment(f.doc)} */\n` : ""}${inner}${f.decl}`).join("\n")}\n${indent}}`
    }
  }
  return "unknown"
}

const docType = (doc: unknown, indent: string) => {
  const d = doc as { schema: unknown; definitions?: Record<string, unknown> }
  return tsType(d.schema, d.definitions ?? {}, new Set(), indent)
}

const typeOf = (schema: Schema.Top, indent: string) => {
  const doc = Schema.toJsonSchemaDocument(schema) as { schema: unknown; definitions?: Record<string, unknown> }
  return tsType(doc.schema, doc.definitions ?? {}, new Set(), indent)
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
  /** Wait: \`yield* Effect.sleep("2 seconds")\` or a number of milliseconds. */
  sleep(duration: string | number): Eff<void>
}
/** Time: the only way a cell reads it (\`Date.now()\` and \`new Date()\` are refused, so runs can be replayed). */
declare const Clock: {
  /** Now, in milliseconds since the epoch: \`const now = yield* Clock.currentTimeMillis\`. */
  readonly currentTimeMillis: Eff<number>
}
/** Randomness: the only way a cell reads it (\`Math.random()\` is refused, so runs can be replayed). */
declare const Random: {
  /** A number in [0, 1): \`const r = yield* Random.next\`. */
  readonly next: Eff<number>
  readonly nextInt: Eff<number>
  /** A number in [min, max). */
  nextBetween(min: number, max: number): Eff<number>
  /** An integer in [min, max]. */
  nextIntBetween(min: number, max: number): Eff<number>
  shuffle<A>(elements: Iterable<A>): Eff<Array<A>>
}
declare const console: { log(...values: unknown[]): void; error(...values: unknown[]): void }
`

/** TypeScript declarations for a set of services: what the model reads and what cells are typechecked against. */
export const manifest = (services: ReadonlyArray<ServiceDef>): string =>
  PRELUDE +
  services
    .map((svc) =>
      [
        `/** ${comment(svc.doc)} */`,
        `declare const ${svc.name}: {`,
        ...Object.entries(svc.methods).map(
          ([m, def]) => `  /** ${comment(def.doc)} */\n  ${m}(params: ${def.json ? docType(def.json.params, "  ") : typeOf(def.params, "  ")}): Eff<${def.json ? docType(def.json.success, "  ") : typeOf(def.success, "  ")}>`,
        ),
        "}",
      ].join("\n"),
    )
    .join("\n\n") +
  "\n"
