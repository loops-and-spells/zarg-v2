import { expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { BG, cast, FG, frame, frameOf } from "../src"

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

test("a wide character covers two columns once; the row still spans every column", async () => {
  const f = frameOf(await term(6, 1, "a界b"))
  expect(f.lines[0]).toEqual([{ t: "a界b  ", cells: 6 }])
})

test("the same screen gives the same bytes; a cast is the asciicast as given", async () => {
  const a = frame("x", await term(10, 2, "\x1b[32mhi\x1b[0m"))
  const b = frame("x", await term(10, 2, "\x1b[32mhi\x1b[0m"))
  expect(a.kind).toBe("evidence-terminal/frame")
  expect(a.files["frame.json"]).toBe(b.files["frame.json"] as string)
  expect(cast("step", '{"version":2}\n')).toEqual({ kind: "evidence-terminal/cast", caption: "step", files: { "step.cast": '{"version":2}\n' } })
})
