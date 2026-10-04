/** The router lists every model a tier needs; the suite never starts, loads or warms one. */
export const preflight = async (url: string, models: ReadonlyArray<string>): Promise<void> => {
  let listed: ReadonlySet<string> = new Set()
  try {
    const r = await fetch(`${url}/models`, { signal: AbortSignal.timeout(5_000) })
    const body = (await r.json()) as { data?: ReadonlyArray<{ id?: string }> }
    listed = new Set((body.data ?? []).map((m) => String(m.id)))
  } catch {
    // Nothing answers: every model is missing.
  }
  const missing = models.find((m) => !listed.has(m))
  if (missing !== undefined) throw new Error(`zarg-router at ${url} does not list ${missing}: start the router and load it`)
}
