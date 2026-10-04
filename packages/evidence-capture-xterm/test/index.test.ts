import { expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { BG, cast, FG, frame, frameOf, gif } from "../src"

const term = async (cols: number, rows: number, text: string) => {
  const t = new Terminal({ cols, rows, allowProposedApi: true })
  await new Promise<void>((r) => t.write(text, r))
  return t
}

test("a frame: spans merge by look; palette, 256 and truecolor resolve to hex; inverse swaps; defaults draw nothing", async () => {
  const f = frameOf(await term(12, 2, "\x1b[1;31mok\x1b[0m \x1b[38;5;208mor\x1b[38;2;1;2;3mx\x1b[0m\r\n\x1b[7mInv\x1b[0m"))
  expect(f).toMatchObject({ cols: 12, rows: 2, fg: FG, bg: BG })
  expect(f.lines[0]).toEqual([
    { t: "ok", fg: "#cd3131", b: true, cells: 2 },
    { t: " ", cells: 1 },
    { t: "or", fg: "#ff8700", cells: 2 },
    { t: "x", fg: "#010203", cells: 1 },
    { t: "      ", cells: 6 },
  ])
  expect(f.lines[1]).toEqual([{ t: "Inv", fg: BG, bg: FG, cells: 3 }, { t: "         ", cells: 9 }])
})

test("a wide character (or one outside the BMP, an emoji, whose glyph is wider than its column) is a span of its own: every other span has one column per character, so nothing after it drifts", async () => {
  const f = frameOf(await term(8, 1, "a界b😀c"))
  expect(f.lines[0]).toEqual([{ t: "a", cells: 1 }, { t: "界", cells: 2 }, { t: "b", cells: 1 }, { t: "😀", cells: 1 }, { t: "c  ", cells: 3 }])
})

test("the same screen gives the same bytes; a cast is the asciicast as given", async () => {
  const a = frame("x", await term(10, 2, "\x1b[32mhi\x1b[0m"))
  const b = frame("x", await term(10, 2, "\x1b[32mhi\x1b[0m"))
  expect(a.kind).toBe("evidence-terminal/frame")
  expect(a.files["frame.json"]).toBe(b.files["frame.json"] as string)
  expect(cast("step", '{"version":2}\n')).toEqual({ kind: "evidence-terminal/cast", caption: "step", files: { "step.cast": '{"version":2}\n' } })
})

test("a step's cast is the session so far, starting at the step (the player fast-forwards: the screen is whole from its first frame)", () => {
  expect(cast("step", '{"version":2}\n', { startAt: 3.9 })).toEqual({ kind: "evidence-terminal/cast", caption: "step", files: { "step.cast": '{"version":2}\n' }, meta: { startAt: 3.9 } })
})

test("minors: hidden text (SGR 8) is marked; a gif is made only when asked (ZARG_EVIDENCE_GIF=1), so evidence does not depend on the machine", async () => {
  const f = frameOf(await term(4, 1, "\x1b[8mab\x1b[0m"))
  expect(f.lines[0]![0]).toEqual({ t: "ab", h: true, cells: 2 })
  const before = process.env.ZARG_EVIDENCE_GIF
  delete process.env.ZARG_EVIDENCE_GIF
  expect(gif("g", '{"version":2}\n')).toBeUndefined()
  if (before !== undefined) process.env.ZARG_EVIDENCE_GIF = before
})
