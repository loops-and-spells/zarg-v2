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
