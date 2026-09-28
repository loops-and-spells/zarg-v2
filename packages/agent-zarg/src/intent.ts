import { parse } from "@zarg/frontmatter"

/** One way to go on, offered when nothing is open: what the operator picks becomes their word to the driver. */
export interface NextOption {
  readonly id: string
  readonly label: string
  readonly why?: string
  readonly task: string
}

/** The goals in an intent's frontmatter (`next: [{ name, why? }]`), in order; the prose is never read. */
export const nextGoals = (markdown: string, file: string): ReadonlyArray<NextOption> => {
  let data: { readonly [key: string]: unknown }
  try {
    data = parse(markdown).data
  } catch {
    return []
  }
  const next = Array.isArray(data.next) ? (data.next as ReadonlyArray<unknown>) : []
  return next.flatMap((g, i) => {
    const o = (g ?? {}) as { readonly name?: unknown; readonly why?: unknown }
    if (typeof o.name !== "string" || o.name === "") return []
    const why = typeof o.why === "string" && o.why !== "" ? o.why.replace(/\.$/, "") : undefined
    return [{ id: `${file}#${i + 1}`, label: o.name, ...(why !== undefined ? { why } : {}), task: `Work on the next goal in ${file}: ${o.name}${why !== undefined ? `: ${why}` : ""}.` }]
  })
}
