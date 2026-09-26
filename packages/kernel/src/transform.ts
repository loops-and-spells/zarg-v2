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
