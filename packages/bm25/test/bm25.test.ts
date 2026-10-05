import { describe, expect, test } from "bun:test"
import { bm25, rank, tokens } from "../src"

describe("tokens", () => {
  test("lowercase words and numbers; punctuation splits; light stemming folds plurals and -ing/-ed", () => {
    expect(tokens("The Card's DECLINED, checkouts: 3 retries!")).toEqual(["the", "card", "s", "declin", "checkout", "3", "retry"])
    expect(tokens("paying paid boxes class")).toEqual(["pay", "paid", "box", "class"])
    expect(tokens("")).toEqual([])
  })
})

describe("bm25", () => {
  test("matches the formula on a corpus small enough to work by hand", () => {
    // N=2, the term in one doc: idf = ln(1 + 1.5/1.5) = ln 2; tf=1 and |d| = avgdl, so the tf part is 1.
    expect(rank(["a b", "b c"], "a")[0]).toBeCloseTo(Math.LN2, 10)
    expect(rank(["a b", "b c"], "a")[1]).toBe(0)
  })
  test("more of the query ranks higher; a shorter doc with the same hits ranks higher", () => {
    const s = rank(["card declined at checkout", "checkout", "login page unclear", "the checkout said nothing when the card was declined and nothing else happened"], "declined card")
    expect(s[0]!).toBeGreaterThan(s[3]!)
    expect(s[3]!).toBeGreaterThan(s[1]!)
    expect(s[2]).toBe(0)
  })
  test("stems match across forms; a blank query, no docs or empty docs score nothing and never throw", () => {
    expect(rank(["missing receipts"], "receipt")[0]!).toBeGreaterThan(0)
    expect(rank(["a", "b"], "   ")).toEqual([0, 0])
    expect(rank([], "x")).toEqual([])
    expect(rank(["", "x"], "x")[0]).toBe(0)
  })
  test("one index answers many queries", () => {
    const ix = bm25(["alpha beta", "beta gamma"])
    expect(ix.score("alpha")[0]!).toBeGreaterThan(0)
    expect(ix.score("gamma")[1]!).toBeGreaterThan(0)
  })
  test("a word still being typed matches the words it begins (a whole word still ranks first)", () => {
    const s = rank(["zarg-router:jevk5", "zarg-router:deepseek-v4", "jevk"], "jevk")
    expect(s[0]!).toBeGreaterThan(0)
    expect(s[1]).toBe(0)
    expect(s[2]!).toBeGreaterThan(s[0]!)
  })
})
