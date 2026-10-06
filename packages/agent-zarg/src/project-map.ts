/**
 * The project at a glance (from its tracked files): folders with their file counts, the READMEs and the docs, so a
 * driver item starts where to read instead of spending its turns finding out. zarg's own files are left out.
 */
export const projectMap = (files: ReadonlyArray<string>): string => {
  const mine = files.filter((f) => !f.startsWith(".zarg/") && !f.includes("node_modules/"))
  const top = new Map<string, number>()
  const loose: Array<string> = []
  for (const f of mine) {
    const at = f.indexOf("/")
    if (at < 0) loose.push(f)
    else top.set(`${f.slice(0, at)}/`, (top.get(`${f.slice(0, at)}/`) ?? 0) + 1)
  }
  const dirs = [...top.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, n]) => `${d} (${n})`)
  const readmes = mine.filter((f) => /(^|\/)README(\.[a-z]+)?$/i.test(f)).slice(0, 10)
  const docs = mine.filter((f) => f.startsWith("docs/") && /\.(md|mdx|txt)$/i.test(f)).sort().slice(0, 15)
  return [
    `Project files (${mine.length}): ${[...dirs, ...loose.slice(0, 15)].join(", ") || "none"}`,
    ...(readmes.length > 0 ? [`READMEs: ${readmes.join(", ")}`] : []),
    ...(docs.length > 0 ? [`Docs: ${docs.join(", ")}`] : []),
  ].join("\n")
}
