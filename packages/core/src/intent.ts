/** One way to go on, offered when nothing is open: what the developer picks becomes their word to the driver. */
export interface NextOption {
  readonly id: string
  readonly label: string
  readonly why?: string
  readonly task: string
}

/**
 * The numbered goals under an intent's `Next:` line, in order. `**Name**: rest` gives the label and a why;
 * a plain item is its own label.
 */
export const nextGoals = (markdown: string, file: string): ReadonlyArray<NextOption> => {
  const lines = markdown.split("\n")
  const at = lines.findIndex((l) => l.trim() === "Next:")
  if (at < 0) return []
  const out: Array<NextOption> = []
  for (const line of lines.slice(at + 1)) {
    const item = /^(\d+)\.\s+(.*)$/.exec(line.trim())
    if (item === null) {
      // Blank lines before the list and wrapped lines inside it; anything else ends it.
      if (line.trim() === "" ? out.length === 0 : /^\s/.test(line) && out.length > 0) continue
      break
    }
    const named = /^\*\*(.+?)\*\*:?\s*(.*)$/.exec(item[2]!)
    const label = named !== null ? named[1]! : item[2]!.replace(/\.$/, "")
    const why = named !== null && named[2]!.length > 0 ? named[2]!.replace(/\.$/, "") : undefined
    out.push({ id: `${file}#${item[1]}`, label, ...(why !== undefined ? { why } : {}), task: `Work on the next goal in ${file}: ${label}${why !== undefined ? `: ${why}` : ""}.` })
  }
  return out
}
