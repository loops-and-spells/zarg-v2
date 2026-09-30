/** Whether a card is built (its code is tagged), planned (not built yet), or untagged (neither: the audit's problem). */
export type Built = "built" | "planned" | "untagged"

/**
 * Testers walk only what is built: each story stops before its first planned or untagged card, and a story left
 * empty goes. The notes say why, once per card, for the run.
 */
export const cutStories = (stories: ReadonlyArray<ReadonlyArray<string>>, built: (card: string) => Built) => {
  const notes = new Map<string, string>()
  const out = stories.flatMap((s) => {
    const at = s.findIndex((c) => built(c) !== "built")
    if (at >= 0) {
      const c = s[at]!
      notes.set(c, built(c) === "planned" ? `${c}: not built yet (planned): not walked` : `${c}: no code tagged and not planned: tag its code or mark it planned`)
    }
    const kept = at >= 0 ? s.slice(0, at) : s
    return kept.length > 0 ? [kept] : []
  })
  // Two stories cut to the same path are one story.
  const seen = new Set<string>()
  return { stories: out.filter((s) => (seen.has(s.join(">")) ? false : (seen.add(s.join(">")), true))), notes: [...notes.values()] }
}
