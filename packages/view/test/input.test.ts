import { describe, expect, test } from "bun:test"
import { dispatch, hintsOf, type InputLayer, printable } from "../src/input"

type U = { readonly n: number }
const layer = (id: string, owns: (k: string) => boolean, on = true): InputLayer<U, { on: boolean }, string> => ({
  id,
  when: (_u, w) => (id === "bottom" ? w.on : on),
  hints: () => [{ keys: id, does: `${id} things` }],
  handle: (u, _w, k) => (owns(k.name) ? { ui: { n: u.n + 1 }, action: `${id}:${k.name}` } : "pass"),
})
const layers = [layer("global", (k) => k === "q"), layer("top", (k) => k === "x"), layer("mid", (k) => k === "up"), layer("bottom", () => true)]

describe("input layers", () => {
  test("a key goes to the first layer on the stack that owns it", () => {
    expect(dispatch(layers, { n: 0 }, { on: true }, { name: "x" })).toEqual({ ui: { n: 1 }, action: "top:x", by: "top" })
    expect(dispatch(layers, { n: 0 }, { on: true }, { name: "up" }).by).toBe("mid")
    expect(dispatch(layers, { n: 0 }, { on: true }, { name: "z" }).by).toBe("bottom")
  })
  test("a key no layer owns does nothing", () => {
    expect(dispatch(layers, { n: 0 }, { on: false }, { name: "z" })).toEqual({ ui: { n: 0 } })
  })
  test("hints come from the top layers below global", () => {
    expect(hintsOf(layers, { n: 0 }, { on: true }).map((h) => h.keys)).toEqual(["top", "mid"])
  })
  test("printable: one character, space or Backspace, without Ctrl or Alt", () => {
    expect([{ name: "a" }, { name: "space" }, { name: "backspace" }, { name: "/" }].every(printable)).toBe(true)
    expect([{ name: "up" }, { name: "a", ctrl: true }, { name: "a", meta: true }, { name: "return" }].some(printable)).toBe(false)
  })
})
