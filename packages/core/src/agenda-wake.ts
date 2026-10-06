/** Whether an agenda holds work zarg has not seen: an item new since the last look (one gone, or the same again, is not). */
export const newWork = () => {
  let seen = new Set<string>()
  return (ids: ReadonlyArray<string>) => {
    const fresh = ids.some((id) => !seen.has(id))
    seen = new Set(ids)
    return fresh
  }
}
