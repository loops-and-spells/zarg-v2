/**
 * Okapi BM25 over short texts: rank documents by how well they match a query.
 * Tokens are lowercase letters and digits; a light stemmer folds plurals, -ing and -ed.
 */

/** A light English stemmer: enough for "checkouts" to find "checkout", not a Porter stemmer. */
const stem = (w: string): string => {
  if (w.length <= 3) return w
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`
  if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.endsWith("ss")) return w
  if (w.endsWith("s")) return w.slice(0, -1)
  if (w.endsWith("ing") && w.length - 3 >= 3) return w.slice(0, -3)
  if (w.endsWith("ed") && w.length - 2 >= 4) return w.slice(0, -2)
  return w
}

export const tokens = (text: string): ReadonlyArray<string> => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem)

export interface Bm25Options {
  /** Term frequency saturation (default 1.2). */
  readonly k1?: number
  /** Length normalisation (default 0.75). */
  readonly b?: number
}

/** An index of documents: `score(query)` gives each document's score, in document order (0: no match). */
export const bm25 = (docs: ReadonlyArray<string>, options: Bm25Options = {}) => {
  const k1 = options.k1 ?? 1.2
  const b = options.b ?? 0.75
  const terms = docs.map((d) => {
    const tf = new Map<string, number>()
    for (const t of tokens(d)) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { tf, length: [...tf.values()].reduce((a, n) => a + n, 0) }
  })
  const avgdl = terms.reduce((a, d) => a + d.length, 0) / Math.max(1, terms.length)
  const df = new Map<string, number>()
  for (const d of terms) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const n = terms.length
  const idf = (t: string) => {
    const has = df.get(t) ?? 0
    return Math.log(1 + (n - has + 0.5) / (has + 0.5))
  }
  return {
    score: (query: string): ReadonlyArray<number> => {
      const q = [...new Set(tokens(query))]
      return terms.map((d) =>
        q.reduce((sum, t) => {
          const f = d.tf.get(t) ?? 0
          return f === 0 ? sum : sum + (idf(t) * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.length) / (avgdl || 1)))
        }, 0),
      )
    },
  }
}

/** Each document's score for one query. */
export const rank = (docs: ReadonlyArray<string>, query: string, options?: Bm25Options) => bm25(docs, options).score(query)
