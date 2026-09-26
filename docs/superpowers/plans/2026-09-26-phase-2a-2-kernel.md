# Phase 2a-2: Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@zarg/kernel`: yieldable service definitions, the TypeScript manifest they generate, and a Bun Worker kernel that typechecks each cell against the manifest and runs it as an Effect generator whose service calls cross to the host over typed RPC.

**Architecture:** A service is a name, a doc line and Schema-typed methods (`defineService`), bound to host handlers (`bind`). `manifest(defs)` turns the Schemas into TypeScript declarations; the same text is what the model reads and what an in-memory TypeScript 5 LanguageService checks each cell against. A cell's top-level declarations are hoisted and persisted as worker globals. In the worker, services are stubs that post calls to the host; the host decodes params with the method's Schema, runs the handler, encodes the result, and replies. Timeouts replace the worker; interrupting a cell interrupts its host-side calls.

**Tech Stack:** bun 1.4.2 (via mise), Effect `4.0.0-rc.117`, TypeScript 5.9 (`typescript5` alias, compiler API for cells only), Bun Workers, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-25-agent-runtime-design.md` (sections Kernel, Services; build step 5). Plan 2a-3 builds `@zarg/rlm` and the core services on this kernel.

## Global Constraints

- Run bun only as `mise x -- bun ...`; every package task already does.
- Effect is the `rc` tag (`4.0.0-rc.117`). The repo's own typecheck stays on TypeScript 7 (`bunx tsc`); the kernel depends on `typescript5` (`npm:typescript@5.9`) only because TypeScript 7 has no in-process compiler API.
- Service names are PascalCase, method names camelCase (`defineService` enforces it).
- Only JSON crosses the worker boundary. A failed service call crosses as `{ _tag, message }`.
- Cells cannot `import`; everything comes from services. Cells are generator bodies: `yield*` service calls, `return` a value.
- `mise run verify` must pass at the end of every task. Commit after every task, ending the message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every code block was prototyped and passes (`mise run verify`: 149 tests). Check `node_modules/.bun/effect@*/node_modules/effect/src/` before changing an Effect API call.

### Deliberate differences from the spec

- The typecheck uses TypeScript 5's compiler API, not TypeScript 7 (see above).
- The manifest types service calls with a minimal `Eff<A>` (an iterator whose `yield*` gives `A`) and a small typed `Effect` object (`catch`, `succeed`, `all`) instead of Effect's full type definitions. At runtime cells get the real `Effect`. This keeps the check at about 4 ms per cell.
- A cell's failure is reported as `error: <Tag>: <message>` in the output rather than as a typed value; the RLM (2a-3) feeds that output back to the model.

## Review Focus

1. A cell that shadows a global from an earlier cell (`const x` again) must still persist the new value (Task 2 hoisting test covers the rewrite; Task 3 persistence test covers the round trip).
2. A cell that returns early or fails must still persist the names it declared before that point (Task 2: the persist step is in a `finally`).
3. Params that pass the typecheck via a cast (`as any`) but break the Schema must be refused by the host, never reach the handler (Task 3).
4. An infinite loop must not hang the host: the cell times out, the worker is replaced, and the model is told its globals are gone (Task 3).
5. Interrupting a cell mid-call must interrupt the host-side handler, so a slow service stops working (Task 3).

---

### Task 1: Service definitions and the manifest

**Files:**
- Create: `packages/kernel/{package.json,tsconfig.json,mise.toml}`
- Create: `packages/kernel/src/{service.ts,manifest.ts,index.ts}`
- Create: `packages/kernel/test/{fixtures.ts,manifest.test.ts}`

**Interfaces:**
- Produces:
  - `defineService(name, doc, methods)`: `ServiceDef`; `MethodDef { doc, params: Schema, success: Schema }`
  - `bind(def, handlers)`: `Bound`; `Handlers<M>` maps each method to `(params) => Effect<success, ServiceFailure>`
  - `ServiceFailure { _tag, message }`
  - `tsType(jsonSchema, defs?)`: string; `manifest(defs)`: string; `PRELUDE`
- Test fixture `Notes` service (`add`, `get`, `fail`, `slow`) and `notes()` (bound handlers with counters), reused by Tasks 2 and 3.

- [ ] **Step 1: Create the package**

```bash
mkdir -p packages/kernel/src packages/kernel/test
cp packages/graph/tsconfig.json packages/graph/mise.toml packages/kernel/
```

`packages/kernel/package.json`:

```json
{
  "name": "@zarg/kernel",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

```bash
cd packages/kernel && mise x -- bun add effect@rc typescript5@npm:typescript@5.9 && cd ../..
```

- [ ] **Step 2: Write the failing tests**

`packages/kernel/test/fixtures.ts`:

```ts
import { Effect, Schema } from "effect"
import { bind, defineService } from "../src"

export const Notes = defineService("Notes", "A tiny note store for tests.", {
  add: { doc: "Store a note; returns its id.", params: Schema.Struct({ text: Schema.String }), success: Schema.Struct({ id: Schema.String }) },
  get: { doc: "Read a note by id.", params: Schema.Struct({ id: Schema.String }), success: Schema.String },
  fail: { doc: "Always fails with Nope.", params: Schema.Struct({}), success: Schema.String },
  slow: { doc: "Wait, then return.", params: Schema.Struct({ ms: Schema.Number }), success: Schema.String },
})

/** Bound Notes with observable side effects for assertions. */
export const notes = () => {
  const store = new Map<string, string>()
  const seen = { interrupted: 0, calls: 0 }
  const bound = bind(Notes, {
    add: ({ text }) =>
      Effect.sync(() => {
        seen.calls++
        const id = `n${store.size + 1}`
        store.set(id, text)
        return { id }
      }),
    get: ({ id }) => {
      const v = store.get(id)
      return v === undefined ? Effect.fail({ _tag: "NotFound", message: `no note ${id}` }) : Effect.succeed(v)
    },
    fail: () => Effect.fail({ _tag: "Nope", message: "always fails" }),
    slow: ({ ms }) =>
      Effect.sleep(ms).pipe(
        Effect.as("slept"),
        Effect.onInterrupt(() => Effect.sync(() => void seen.interrupted++)),
      ),
  })
  return { bound, store, seen }
}
```

`packages/kernel/test/manifest.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { manifest, tsType } from "../src"
import { Notes } from "./fixtures"

const ts = (s: Schema.Top) => {
  const d = Schema.toJsonSchemaDocument(s) as { schema: unknown; definitions?: Record<string, unknown> }
  return tsType(d.schema, d.definitions)
}

describe("tsType", () => {
  test("structs, optional keys, arrays, literals, unions, records, numbers", () => {
    expect(ts(Schema.Struct({ a: Schema.String, b: Schema.optionalKey(Schema.Number) }))).toBe("{ a: string; b?: number }")
    expect(ts(Schema.Array(Schema.Boolean))).toBe("ReadonlyArray<boolean>")
    expect(ts(Schema.Literals(["x", "y"]))).toBe('"x" | "y"')
    expect(ts(Schema.NullOr(Schema.String))).toBe("string | null")
    expect(ts(Schema.Record(Schema.String, Schema.Number))).toBe("Readonly<Record<string, number>>")
    expect(ts(Schema.Struct({}))).toBe("{}")
  })
})

describe("manifest", () => {
  test("declares each service with its doc lines and typed methods", () => {
    const text = manifest([Notes])
    expect(text).toContain("/** A tiny note store for tests. */\ndeclare const Notes: {")
    expect(text).toContain("  /** Store a note; returns its id. */\n  add(params: { text: string }): Eff<{ id: string }>")
    expect(text).toContain("interface Eff<A>")
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/kernel && mise x -- bun test`
Expected: FAIL, cannot resolve `../src`.

- [ ] **Step 4: Implement**

`packages/kernel/src/service.ts`:

```ts
import type { Effect, Schema } from "effect"

/** One method a cell can call: `yield* Service.method(params)`. */
export interface MethodDef<P = any, S = any> {
  readonly doc: string
  readonly params: Schema.Codec<P, any>
  readonly success: Schema.Codec<S, any>
}

/** A yieldable service: its name as cells see it, a doc line, and its methods. */
export interface ServiceDef<M extends Record<string, MethodDef> = Record<string, MethodDef>> {
  readonly name: string
  readonly doc: string
  readonly methods: M
}

export const defineService = <const M extends Record<string, MethodDef>>(name: string, doc: string, methods: M): ServiceDef<M> => {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`service name "${name}" must be PascalCase`)
  for (const m of Object.keys(methods)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(m)) throw new Error(`method "${name}.${m}" must be camelCase`)
  }
  return { name, doc, methods }
}

/** What crosses the kernel boundary when a method fails: a tag the cell can `catchTag` on, and a message. */
export interface ServiceFailure {
  readonly _tag: string
  readonly message: string
}

/** Host-side implementation of a service definition. */
export type Handlers<M extends Record<string, MethodDef>> = {
  readonly [K in keyof M]: (params: Schema.Schema.Type<M[K]["params"]>) => Effect.Effect<Schema.Schema.Type<M[K]["success"]>, ServiceFailure>
}

/** A service definition paired with its host implementation. */
export interface Bound {
  readonly def: ServiceDef
  readonly handlers: Readonly<Record<string, (params: any) => Effect.Effect<unknown, ServiceFailure>>>
}

export const bind = <M extends Record<string, MethodDef>>(def: ServiceDef<M>, handlers: Handlers<M>): Bound => ({
  def,
  handlers: handlers as Bound["handlers"],
})
```

`packages/kernel/src/manifest.ts`:

```ts
import { Schema } from "effect"
import type { ServiceDef } from "./service"

const isNumberEncoding = (s: any) =>
  Array.isArray(s?.anyOf) &&
  s.anyOf.length === 2 &&
  s.anyOf.some((x: any) => x.type === "number") &&
  s.anyOf.some((x: any) => x.type === "string" && Array.isArray(x.enum) && x.enum.includes("NaN"))

const key = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k))

/** JSON Schema (as Effect emits it) → a TypeScript type, for the model to read and the checker to enforce. */
export const tsType = (s: any, defs: Record<string, any> = {}): string => {
  if (s === undefined || s === true || (typeof s === "object" && Object.keys(s).length === 0)) return "unknown"
  if (s.$ref !== undefined) return tsType(defs[String(s.$ref).split("/").pop()!], defs)
  // Effect encodes an empty struct as "anything but null", which TypeScript spells {}.
  if (s.not?.type === "null" && Object.keys(s).length === 1) return "{}"
  if (isNumberEncoding(s)) return "number"
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ")
  if (s.const !== undefined) return JSON.stringify(s.const)
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    return [...new Set((s.anyOf ?? s.oneOf).map((x: any) => tsType(x, defs)))].join(" | ")
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
        ? `readonly [${s.prefixItems.map((x: any) => tsType(x, defs)).join(", ")}]`
        : `ReadonlyArray<${tsType(s.items, defs)}>`
    case "object": {
      const props = Object.entries(s.properties ?? {})
      const required = new Set<string>(s.required ?? [])
      const fields = props.map(([k, v]) => `${key(k)}${required.has(k) ? "" : "?"}: ${tsType(v, defs)}`)
      if (props.length === 0 && typeof s.additionalProperties === "object") {
        return `Readonly<Record<string, ${tsType(s.additionalProperties, defs)}>>`
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
```

`packages/kernel/src/index.ts` (Tasks 2 and 3 add exports):

```ts
export * from "./manifest"
export * from "./service"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/kernel && mise x -- bun test`
Expected: PASS, 2 tests.

- [ ] **Step 6: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/kernel bun.lock
git commit -m "feat(kernel): yieldable service definitions and the manifest they generate

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Cell transform and typecheck

**Files:**
- Create: `packages/kernel/src/{transform.ts,check.ts}`, `packages/kernel/test/transform.test.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: Task 1 `manifest`, `Notes`.
- Produces:
  - `topLevelNames(cell)`: names declared at the cell's top level (variables including destructuring, functions, classes)
  - `toBody(cell)`: `{ body, names }`: JS generator body with top-level `const`/`let` rewritten to `var`, `class K {}` to `var K = class K {}`, and each name copied to `globalThis` in a `finally`
  - `makeChecker(manifest)`: `{ check(cell): { ok, errors: ["line N: message"] }, declare(names), reset() }`

- [ ] **Step 1: Write the failing tests**

`packages/kernel/test/transform.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { makeChecker, manifest, toBody, topLevelNames } from "../src"
import { Notes } from "./fixtures"

describe("topLevelNames", () => {
  test("variables, destructuring, functions and classes at the top level only", () => {
    const cell = "const a = 1\nlet { b, c: [d] } = x\nfunction f() { const inner = 1 }\nclass K {}\nif (a) { const nested = 2 }"
    expect(topLevelNames(cell)).toEqual(["a", "b", "d", "f", "K"])
  })
})

describe("toBody", () => {
  test("strips types and persists top-level names in a finally", () => {
    const { body, names } = toBody("const n: number = 1\nreturn n")
    expect(names).toEqual(["n"])
    expect(body).not.toContain(": number")
    expect(body).toContain('finally {\ntry { globalThis["n"] = n } catch {}')
  })
})

describe("checker", () => {
  const checker = makeChecker(manifest([Notes]))
  test("a correct cell passes", () => {
    expect(checker.check('const r = yield* Notes.add({ text: "hi" })\nreturn r.id')).toEqual({ ok: true, errors: [] })
  })
  test("a service outside the manifest is an error on the cell's own line numbers", () => {
    const r = checker.check("const x = 1\nconst y = yield* Fs.read({ path: 'a' })")
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toBe("line 2: Cannot find name 'Fs'.")
  })
  test("wrong params are an error", () => {
    expect(checker.check("yield* Notes.add({ text: 1 })").errors[0]).toContain("line 1:")
  })
  test("names from earlier cells are known after declare, and forgotten after reset", () => {
    expect(checker.check("return earlier").ok).toBe(false)
    checker.declare(["earlier"])
    expect(checker.check("return earlier").ok).toBe(true)
    checker.reset()
    expect(checker.check("return earlier").ok).toBe(false)
  })
})

describe("toBody hoisting", () => {
  test("const, let and class become var so the finally can persist them", () => {
    const { body } = toBody("const a = 1\nlet b = 2\nclass K {}\nfunction f() { const inner = 3 }")
    expect(body).toContain("var a = 1")
    expect(body).toContain("var b = 2")
    expect(body).toContain("var K = class K")
    expect(body).toContain("const inner = 3")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/kernel && mise x -- bun test test/transform.test.ts`
Expected: FAIL, `toBody` is not exported.

- [ ] **Step 3: Implement**

`packages/kernel/src/transform.ts`:

```ts
import ts from "typescript5"

/** Names declared at the top level of a cell: they persist as kernel globals for later cells. */
export const topLevelNames = (cell: string): ReadonlyArray<string> => {
  const sf = ts.createSourceFile("cell.ts", cell, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const names: Array<string> = []
  const bind = (n: ts.BindingName) => {
    if (ts.isIdentifier(n)) names.push(n.text)
    else for (const el of n.elements) if (!ts.isOmittedExpression(el)) bind(el.name)
  }
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bind(d.name)
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.push(st.name.text)
  }
  return [...new Set(names)]
}

const WRAP_OPEN = "function* __cell() {\n"

/**
 * Top-level `const`/`let` become `var` and `class K {}` becomes `var K = class K {}`, so every
 * top-level name is function-scoped and visible to the `finally` that persists it.
 */
const hoist: ts.TransformerFactory<ts.SourceFile> = (ctx) => (sf) => {
  const fn = sf.statements[0]
  if (fn === undefined || !ts.isFunctionDeclaration(fn) || fn.body === undefined) return sf
  const statements = fn.body.statements.map((st): ts.Statement => {
    if (ts.isVariableStatement(st)) {
      return ctx.factory.updateVariableStatement(
        st,
        st.modifiers,
        ctx.factory.createVariableDeclarationList(st.declarationList.declarations, ts.NodeFlags.None),
      )
    }
    if (ts.isClassDeclaration(st) && st.name) {
      const cls = ctx.factory.createClassExpression(st.modifiers, st.name, st.typeParameters, st.heritageClauses, st.members)
      return ctx.factory.createVariableStatement(undefined, ctx.factory.createVariableDeclarationList([ctx.factory.createVariableDeclaration(st.name, undefined, undefined, cls)], ts.NodeFlags.None))
    }
    return st
  })
  const body = ctx.factory.updateBlock(fn.body, statements)
  const updated = ctx.factory.updateFunctionDeclaration(fn, fn.modifiers, fn.asteriskToken, fn.name, fn.typeParameters, fn.parameters, fn.type, body)
  return ctx.factory.updateSourceFile(sf, [updated, ...sf.statements.slice(1)])
}

/**
 * Cell TypeScript → the body of a generator function (plain JS).
 * Top-level names are copied to `globalThis` in a `finally`, so they persist even when the cell returns early or fails.
 */
export const toBody = (cell: string): { readonly body: string; readonly names: ReadonlyArray<string> } => {
  const names = topLevelNames(cell)
  const sf = ts.createSourceFile("cell.ts", `${WRAP_OPEN}${cell}\n}`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const hoisted = ts.createPrinter().printFile(ts.transform(sf, [hoist]).transformed[0]!)
  const js = ts.transpileModule(hoisted, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, removeComments: false },
  }).outputText
  const inner = js.slice(js.indexOf("{") + 1, js.lastIndexOf("}"))
  const persist = names.map((n) => `try { globalThis[${JSON.stringify(n)}] = ${n} } catch {}`).join("\n")
  return { body: names.length === 0 ? inner : `try {\n${inner}\n} finally {\n${persist}\n}`, names }
}
```

`packages/kernel/src/check.ts`:

```ts
import { dirname, join } from "node:path"
import ts from "typescript5"

const LIB_DIR = dirname(Bun.resolveSync("typescript5/lib/lib.es2022.d.ts", import.meta.dir))
const HEADER = "function* __cell() {\n"
const HEADER_LINES = HEADER.split("\n").length - 1

export interface CheckResult {
  readonly ok: boolean
  /** "line N: message" per error, with N counted in the cell as the model wrote it. */
  readonly errors: ReadonlyArray<string>
}

/**
 * Typechecks cells against a manifest with an in-memory TypeScript 5 LanguageService.
 * Names declared by earlier cells are known as `any` (they persist as kernel globals).
 */
export const makeChecker = (manifest: string) => {
  const files = new Map<string, { text: string; version: number }>()
  const set = (name: string, text: string) => files.set(name, { text, version: (files.get(name)?.version ?? 0) + 1 })
  set("/manifest.d.ts", manifest)
  set("/globals.d.ts", "")
  set("/cell.ts", "")
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    strict: true,
    noEmit: true,
    types: [],
    noUnusedLocals: false,
  }
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (f) => String(files.get(f)?.version ?? 0),
    getScriptSnapshot: (f) => {
      const mem = files.get(f)
      if (mem) return ts.ScriptSnapshot.fromString(mem.text)
      const path = f.startsWith("/") && !f.startsWith(LIB_DIR) ? join(LIB_DIR, f.slice(1)) : f
      const text = ts.sys.readFile(path)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => join(LIB_DIR, ts.getDefaultLibFileName(o)),
    fileExists: (f) => files.has(f) || ts.sys.fileExists(f),
    readFile: (f) => files.get(f)?.text ?? ts.sys.readFile(f),
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const known = new Set<string>()

  return {
    /** Record names that earlier cells declared, so later cells may use them. */
    declare: (names: Iterable<string>) => {
      for (const n of names) known.add(n)
      set("/globals.d.ts", [...known].map((n) => `declare var ${n}: any`).join("\n"))
    },
    /** Forget earlier names (the kernel was restarted). */
    reset: () => {
      known.clear()
      set("/globals.d.ts", "")
    },
    check: (cell: string): CheckResult => {
      set("/cell.ts", `${HEADER}${cell}\n}\n`)
      const diags = [...service.getSyntacticDiagnostics("/cell.ts"), ...service.getSemanticDiagnostics("/cell.ts")]
      const errors = diags
        .filter((d) => d.category === ts.DiagnosticCategory.Error)
        .map((d) => {
          const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n")
          if (d.file === undefined || d.start === undefined) return msg
          const line = d.file.getLineAndCharacterOfPosition(d.start).line - HEADER_LINES + 1
          return `line ${line}: ${msg}`
        })
      return { ok: errors.length === 0, errors }
    },
  }
}
```

`packages/kernel/src/index.ts`:

```ts
export * from "./check"
export * from "./manifest"
export * from "./service"
export * from "./transform"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/kernel && mise x -- bun test`
Expected: PASS, 9 tests.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/kernel
git commit -m "feat(kernel): cell transform with persisted top-level names, and manifest typecheck

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The Worker kernel

**Files:**
- Create: `packages/kernel/src/{protocol.ts,worker.ts,kernel.ts}`, `packages/kernel/test/kernel.test.ts`
- Modify: `packages/kernel/src/index.ts`, `AGENTS.md`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces (namespace `Kernel`):
  - `Kernel.make({ services: Bound[], timeoutMs? = 120000, outputCap? = 32768 })`: `Effect<Kernel, never, Scope>` where `Kernel = { run(cell): Effect<CellResult>, manifest: string }`
  - `CellResult { ok, output, restarted }`
- Behavior: a cell that fails its typecheck does not run; console lines come before the returned value (strings as-is, else JSON); a failed call reads `error: <Tag>: <message>`; a timeout terminates and respawns the worker and resets the checker; interrupting `run` interrupts in-flight host calls.

- [ ] **Step 1: Write the failing tests**

`packages/kernel/test/kernel.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Kernel } from "../src"
import { notes } from "./fixtures"

const withKernel = <A>(f: (k: Kernel.Kernel, n: ReturnType<typeof notes>) => Effect.Effect<A>, opts: { timeoutMs?: number; outputCap?: number } = {}) => {
  const n = notes()
  return Effect.runPromise(Effect.scoped(Effect.flatMap(Kernel.make({ services: [n.bound], ...opts }), (k) => f(k, n))))
}

describe("Kernel", () => {
  test("returns the cell's value and its console lines", async () => {
    const r = await withKernel((k) => k.run('console.log("hello", { a: 1 })\nreturn { answer: 42 }'))
    expect(r).toEqual({ ok: true, output: 'hello {"a":1}\n{\n  "answer": 42\n}', restarted: false })
  })

  test("service calls cross to the host and back, typed", async () => {
    const r = await withKernel((k) => k.run('const { id } = yield* Notes.add({ text: "x" })\nreturn yield* Notes.get({ id })'))
    expect(r.output).toBe("x")
  })

  test("top-level declarations persist into later cells", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        yield* k.run('const saved = yield* Notes.add({ text: "keep" })')
        return yield* k.run("return yield* Notes.get({ id: saved.id })")
      }),
    )
    expect(out.output).toBe("keep")
  })

  test("functions and classes declared in one cell are usable in the next", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        yield* k.run("function double(n: number) { return n * 2 }\nclass Box { constructor(readonly v: number) {} }")
        return yield* k.run("return double(new Box(21).v)")
      }),
    )
    expect(out.output).toBe("42")
  })

  test("a cell that fails its typecheck does not run", async () => {
    const r = await withKernel((k, n) =>
      Effect.map(k.run('yield* Notes.add({ text: "never" })\nyield* Fs.read({ path: "x" })'), (res) => ({ res, calls: n.seen.calls })),
    )
    expect(r.res.ok).toBe(false)
    expect(r.res.output).toContain("typecheck failed, the cell did not run")
    expect(r.res.output).toContain("line 2: Cannot find name 'Fs'.")
    expect(r.calls).toBe(0)
  })

  test("a failed call fails the cell with its tag, or is caught with Effect.catch", async () => {
    const out = await withKernel((k) =>
      Effect.gen(function* () {
        const uncaught = yield* k.run("return yield* Notes.fail({})")
        const caught = yield* k.run("return yield* Effect.catch(Notes.fail({}), (e) => Effect.succeed(`caught ${e._tag}`))")
        return { uncaught, caught }
      }),
    )
    expect(out.uncaught).toEqual({ ok: false, output: "error: Nope: always fails", restarted: false })
    expect(out.caught.output).toBe("caught Nope")
  })

  test("params that break the schema at runtime are refused by the host", async () => {
    const r = await withKernel((k) => k.run("return yield* Notes.add({ text: 5 } as any)"))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("InvalidParams")
  })

  test("a thrown exception is reported", async () => {
    const r = await withKernel((k) => k.run('throw new Error("boom")'))
    expect(r).toMatchObject({ ok: false })
    expect(r.output).toContain("boom")
  })

  test("a cell past its deadline restarts the kernel; globals are gone", async () => {
    const out = await withKernel(
      (k) =>
        Effect.gen(function* () {
          yield* k.run("const before = 1")
          const slow = yield* k.run("while (true) {}")
          const after = yield* k.run("return before")
          const fresh = yield* k.run("return 'alive'")
          return { slow, after, fresh }
        }),
      { timeoutMs: 300 },
    )
    expect(out.slow).toMatchObject({ ok: false, restarted: true })
    expect(out.slow.output).toContain("kernel was restarted")
    expect(out.after.output).toContain("Cannot find name 'before'")
    expect(out.fresh.output).toBe("alive")
  })

  test("interrupting a cell interrupts its host-side calls", async () => {
    const seen = await withKernel((k, n) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(k.run("return yield* Notes.slow({ ms: 5000 })"))
        yield* Effect.sleep(100)
        yield* Fiber.interrupt(fiber)
        yield* Effect.sleep(50)
        return n.seen.interrupted
      }),
    )
    expect(seen).toBe(1)
  })

  test("large output is capped with a note", async () => {
    const r = await withKernel((k) => k.run("return 'x'.repeat(5000)"), { outputCap: 1000 })
    expect(r.output.length).toBeLessThan(1100)
    expect(r.output).toContain("characters cut")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/kernel && mise x -- bun test test/kernel.test.ts`
Expected: FAIL, `Kernel` is not exported.

- [ ] **Step 3: Implement**

`packages/kernel/src/protocol.ts`:

```ts
import type { ServiceFailure } from "./service"

/** Host → worker. */
export type ToWorker =
  | { readonly type: "init"; readonly services: Readonly<Record<string, ReadonlyArray<string>>> }
  | { readonly type: "run"; readonly id: number; readonly body: string }
  | { readonly type: "interrupt"; readonly id: number }
  | { readonly type: "reply"; readonly callId: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "reply"; readonly callId: number; readonly ok: false; readonly error: ServiceFailure }

/** Worker → host. */
export type FromWorker =
  | { readonly type: "ready" }
  | { readonly type: "call"; readonly runId: number; readonly callId: number; readonly service: string; readonly method: string; readonly params: unknown }
  | { readonly type: "log"; readonly runId: number; readonly line: string }
  | { readonly type: "done"; readonly id: number; readonly ok: true; readonly value: string | undefined }
  | { readonly type: "done"; readonly id: number; readonly ok: false; readonly error: string }
```

`packages/kernel/src/worker.ts`:

```ts
/// <reference lib="webworker" />
// Runs inside a Bun Worker. Cells are generator bodies run with Effect.gen; services are RPC stubs to the host.
import { Cause, Effect, Exit, Fiber } from "effect"
import type { FromWorker, ToWorker } from "./protocol"

declare const self: Worker
const post = (m: FromWorker) => self.postMessage(m)

let serviceNames: ReadonlyArray<string> = []
let services: ReadonlyArray<Record<string, (params: unknown) => Effect.Effect<unknown, unknown>>> = []
const pending = new Map<number, (exit: Exit.Exit<unknown, unknown>) => void>()
const running = new Map<number, Fiber.Fiber<unknown, unknown>>()
let nextCall = 0
let currentRun = 0

const format = (v: unknown): string | undefined =>
  v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v, null, 2)

/** A failure the cell can catch by tag: `Effect.catchTag("StaleNode", ...)`. */
const failure = (e: { _tag: string; message: string }) => Object.assign(new Error(e.message), e)

const stub = (service: string, method: string) => (params: unknown) =>
  Effect.callback<unknown, unknown>((resume) => {
    const callId = ++nextCall
    pending.set(callId, (exit) => resume(exit))
    post({ type: "call", runId: currentRun, callId, service, method, params })
  })

const log = (runId: number) => (...values: Array<unknown>) =>
  post({ type: "log", runId, line: values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ") })

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const m = event.data
  if (m.type === "init") {
    serviceNames = Object.keys(m.services)
    services = serviceNames.map((name) =>
      Object.fromEntries(m.services[name]!.map((method) => [method, stub(name, method)])),
    )
    post({ type: "ready" })
    return
  }
  if (m.type === "reply") {
    const resume = pending.get(m.callId)
    pending.delete(m.callId)
    resume?.(m.ok ? Exit.succeed(m.value) : Exit.fail(failure(m.error)))
    return
  }
  if (m.type === "interrupt") {
    const fiber = running.get(m.id)
    if (fiber) Effect.runFork(Fiber.interrupt(fiber))
    return
  }
  // run
  currentRun = m.id
  let gen: () => Generator<Effect.Effect<any, any, never>, unknown, any>
  try {
    gen = new Function("console", "Effect", ...serviceNames, `return function* () {\n${m.body}\n}`)(
      { log: log(m.id), error: log(m.id) },
      Effect,
      ...services,
    )
  } catch (e) {
    post({ type: "done", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    return
  }
  const fiber = Effect.runFork(Effect.gen(gen))
  running.set(m.id, fiber)
  fiber.addObserver((exit) => {
    running.delete(m.id)
    if (Exit.isSuccess(exit)) post({ type: "done", id: m.id, ok: true, value: format(exit.value) })
    else {
      const err = Cause.squash(exit.cause)
      const text = Cause.hasInterruptsOnly(exit.cause)
        ? "interrupted"
        : err instanceof Error
          ? `${(err as { _tag?: string })._tag ?? err.name}: ${err.message}`
          : String(err)
      post({ type: "done", id: m.id, ok: false, error: text })
    }
  })
}
```

`packages/kernel/src/kernel.ts`:

```ts
import { Deferred, Effect, Exit, FiberSet, Schema } from "effect"
import { makeChecker } from "./check"
import { manifest } from "./manifest"
import type { FromWorker, ToWorker } from "./protocol"
import type { Bound, ServiceFailure } from "./service"
import { toBody } from "./transform"

export interface CellResult {
  /** False when the cell failed to typecheck, threw, failed, or timed out. */
  readonly ok: boolean
  /** Console lines, then the returned value (or the error), capped. */
  readonly output: string
  /** True when the worker was replaced during this cell; earlier globals are gone. */
  readonly restarted: boolean
}

export interface KernelOptions {
  readonly services: ReadonlyArray<Bound>
  /** A cell that runs longer is stopped and the worker replaced. */
  readonly timeoutMs?: number
  /** Output larger than this is cut, keeping head and tail. */
  readonly outputCap?: number
}

const cap = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max / 2)}\n… [${text.length - max} characters cut] …\n${text.slice(-max / 2)}`

const toFailure = (e: unknown): ServiceFailure =>
  typeof e === "object" && e !== null && "_tag" in e
    ? { _tag: String((e as { _tag: unknown })._tag), message: String((e as { message?: unknown }).message ?? "") }
    : { _tag: "Error", message: e instanceof Error ? e.message : String(e) }

/**
 * One kernel: a Bun Worker that runs cells as Effect generator bodies.
 * Service calls cross back to the host, are decoded with the method's params Schema,
 * run with the bound handler, and the result is encoded with its success Schema.
 */
export const make = (opts: KernelOptions) =>
  Effect.gen(function* () {
    const timeoutMs = opts.timeoutMs ?? 120_000
    const outputCap = opts.outputCap ?? 32_768
    const text = manifest(opts.services.map((s) => s.def))
    const checker = makeChecker(text)
    const byName = new Map(opts.services.map((s) => [s.def.name, s]))
    const calls = yield* FiberSet.make()
    const runCall = yield* FiberSet.runtime(calls)<never>()

    let worker: Worker | undefined
    let onMessage: (m: FromWorker) => void = () => {}

    const spawn = Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const w = new Worker(new URL("./worker.ts", import.meta.url))
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        if (e.data.type === "ready") Deferred.doneUnsafe(ready, Exit.void)
        else onMessage(e.data)
      }
      const services = Object.fromEntries(opts.services.map((s) => [s.def.name, Object.keys(s.def.methods)]))
      w.postMessage({ type: "init", services } satisfies ToWorker)
      yield* Deferred.await(ready)
      worker = w
    })
    yield* spawn
    yield* Effect.addFinalizer(() => Effect.sync(() => worker?.terminate()))

    const send = (m: ToWorker) => worker?.postMessage(m)

    // Serve one service call from the worker; typed failures travel back as { _tag, message }.
    const serve = (m: Extract<FromWorker, { type: "call" }>) => {
      const svc = byName.get(m.service)
      const def = svc?.def.methods[m.method]
      const handler = svc?.handlers[m.method]
      const reply = (r: Exit.Exit<unknown, ServiceFailure>) =>
        send(
          Exit.isSuccess(r)
            ? { type: "reply", callId: m.callId, ok: true, value: r.value }
            : { type: "reply", callId: m.callId, ok: false, error: toFailure(r.cause.reasons.find((x) => x._tag === "Fail")?.error ?? r.cause) },
        )
      if (def === undefined || handler === undefined) {
        reply(Exit.fail({ _tag: "UnknownService", message: `${m.service}.${m.method} is not in this kernel's layer` }))
        return Effect.void
      }
      return Schema.decodeUnknownEffect(def.params)(m.params).pipe(
        Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidParams", message: `${m.service}.${m.method}: ${e.message}` })),
        Effect.flatMap(handler),
        Effect.flatMap((value) =>
          Schema.encodeEffect(def.success)(value).pipe(
            Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidResult", message: `${m.service}.${m.method}: ${e.message}` })),
          ),
        ),
        Effect.exit,
        Effect.flatMap((r) => Effect.sync(() => reply(r))),
      )
    }

    let nextRun = 0
    const run = (cell: string): Effect.Effect<CellResult> =>
      Effect.gen(function* () {
        const checked = checker.check(cell)
        if (!checked.ok) {
          return { ok: false, output: cap(`typecheck failed, the cell did not run:\n${checked.errors.join("\n")}`, outputCap), restarted: false }
        }
        const { body, names } = toBody(cell)
        const id = ++nextRun
        const lines: Array<string> = []
        const done = yield* Deferred.make<{ ok: boolean; text: string | undefined }>()
        onMessage = (m) => {
          if (m.type === "log" && m.runId === id) lines.push(m.line)
          else if (m.type === "call" && m.runId === id) runCall(serve(m))
          else if (m.type === "done" && m.id === id) {
            Deferred.doneUnsafe(done, Exit.succeed(m.ok ? { ok: true, text: m.value } : { ok: false, text: m.error }))
          }
        }
        send({ type: "run", id, body })
        const outcome = yield* Deferred.await(done).pipe(
          Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(undefined) }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              send({ type: "interrupt", id })
              yield* FiberSet.clear(calls)
            }),
          ),
        )
        if (outcome === undefined) {
          // Timed out: stop host work, replace the worker. Globals are lost.
          yield* FiberSet.clear(calls)
          worker?.terminate()
          yield* spawn
          checker.reset()
          const out = [...lines, `cell timed out after ${timeoutMs}ms; the kernel was restarted and earlier globals are gone`]
          return { ok: false, output: cap(out.join("\n"), outputCap), restarted: true }
        }
        checker.declare(names)
        const out = [...lines, ...(outcome.text === undefined ? [] : [outcome.ok ? outcome.text : `error: ${outcome.text}`])]
        return { ok: outcome.ok, output: cap(out.join("\n"), outputCap), restarted: false }
      })

    return { run, manifest: text }
  })

export type Kernel = Effect.Success<ReturnType<typeof make>>
```

`packages/kernel/src/index.ts` (final):

```ts
export * from "./check"
export * as Kernel from "./kernel"
export * from "./manifest"
export * from "./service"
export * from "./transform"
```

In `AGENTS.md`, add under Packages after the `packages/decisions` line:

```markdown
- `packages/kernel` (`@zarg/kernel`): yieldable service definitions, the manifest they generate, and the Bun Worker kernel that typechecks and runs cells.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/kernel && mise x -- bun test`
Expected: PASS, 20 tests.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify`
Expected: exit 0, 149 tests.

```bash
git add packages/kernel AGENTS.md
git commit -m "feat(kernel): Bun Worker kernel with typed service RPC, timeouts and interrupts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
