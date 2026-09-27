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
    // Cells are scratch code: the check is for service calls and syntax, not for annotating callbacks over
    // untyped values (earlier cells' names are \`any\`), which failed ~1 cell in 8 in real runs.
    noImplicitAny: false,
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
      const lineOf = (file: ts.SourceFile, pos: number) => file.getLineAndCharacterOfPosition(pos).line - HEADER_LINES + 1
      const diags = [...service.getSyntacticDiagnostics("/cell.ts"), ...service.getSemanticDiagnostics("/cell.ts")]
      const errors = diags
        .filter((d) => d.category === ts.DiagnosticCategory.Error)
        .map((d) => {
          const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n")
          if (d.file === undefined || d.start === undefined) return msg
          return `line ${lineOf(d.file, d.start)}: ${msg}`
        })
      const program = service.getProgram()!
      const file = program.getSourceFile("/cell.ts")!
      errors.push(...unreplayable(file, program.getTypeChecker()).map((u) => `line ${lineOf(file, u.pos)}: ${u.message}`))
      return { ok: errors.length === 0, errors }
    },
  }
}

const CLOCK = "use `yield* Clock.currentTimeMillis`"
const RANDOM = "use `yield* Random.next` (or Random.nextIntBetween, Random.shuffle)"

/**
 * Reads of real time and randomness, which a replay could not reproduce: cells use the Clock and Random
 * services instead. Pure date work (`new Date(ms)`, `Date.parse`) is fine. A name the cell declared itself
 * is not the global.
 */
const unreplayable = (file: ts.SourceFile, checker: ts.TypeChecker) => {
  const found: Array<{ pos: number; message: string }> = []
  const isGlobal = (id: ts.Expression, name: string) => {
    if (!ts.isIdentifier(id) || id.text !== name) return false
    const decls = checker.getSymbolAtLocation(id)?.declarations ?? []
    return decls.every((d) => { const f = d.getSourceFile().fileName; return f !== "/cell.ts" && f !== "/globals.d.ts" })
  }
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n)) {
      if (isGlobal(n.expression, "Date") && n.name.text === "now") found.push({ pos: n.getStart(), message: `Date.now() reads the real clock; ${CLOCK}` })
      else if (isGlobal(n.expression, "Math") && n.name.text === "random") found.push({ pos: n.getStart(), message: `Math.random() is not replayable; ${RANDOM}` })
      else if (isGlobal(n.expression, "performance")) found.push({ pos: n.getStart(), message: `performance is not available; ${CLOCK}` })
      else if (isGlobal(n.expression, "crypto")) found.push({ pos: n.getStart(), message: `crypto is not available; ${RANDOM}` })
    } else if (ts.isNewExpression(n) && isGlobal(n.expression, "Date") && (n.arguments?.length ?? 0) === 0) {
      found.push({ pos: n.getStart(), message: `new Date() reads the real clock; ${CLOCK}, then new Date(ms)` })
    } else if (ts.isCallExpression(n) && isGlobal(n.expression, "Date")) {
      found.push({ pos: n.getStart(), message: `Date() reads the real clock; ${CLOCK}, then new Date(ms)` })
    }
    ts.forEachChild(n, visit)
  }
  visit(file)
  return found
}
