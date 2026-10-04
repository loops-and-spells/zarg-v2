import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Capture } from "@zarg/evidence-capture"
import { PALETTE } from "./palette"

/** What frame() reads of a terminal: xterm's buffer API, structurally (no dependency on xterm). */
export interface CellLike {
  getChars(): string
  getWidth(): number
  getFgColor(): number
  getBgColor(): number
  isFgDefault(): boolean
  isBgDefault(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  isFgRGB(): boolean
  isBgRGB(): boolean
  isBold(): number
  isItalic(): number
  isUnderline(): number
  isInverse(): number
  isDim(): number
}
export interface XtermLike {
  readonly cols: number
  readonly rows: number
  readonly buffer: { readonly active: { readonly viewportY: number; getLine(y: number): { getCell(x: number): CellLike | undefined } | undefined } }
}
/** A run of cells that look the same: its text, colours (hex; none = the frame's default), weight, and the columns it covers. */
export type Span = { readonly t: string; readonly cells: number; readonly fg?: string; readonly bg?: string; readonly b?: true; readonly i?: true; readonly u?: true; readonly d?: true }
export type Frame = { readonly cols: number; readonly rows: number; readonly fg: string; readonly bg: string; readonly lines: ReadonlyArray<ReadonlyArray<Span>> }
export const FG = "#c0c0c0"
export const BG = "#101010"

const rgb = (n: number) => `#${n.toString(16).padStart(6, "0")}`
const colour = (palette: boolean, isRgb: boolean, value: number) => (isRgb ? rgb(value) : palette ? PALETTE[value] : undefined)

const LOOK = ["fg", "bg", "b", "i", "u", "d"] as const
const sameLook = (a: Omit<Span, "t" | "cells">, b: Omit<Span, "t" | "cells">) => LOOK.every((k) => a[k] === b[k])

/** The screen as coloured spans: adjacent cells that look the same merge; inverse is resolved; a wide cell's spacer is skipped. */
export const frameOf = (term: XtermLike): Frame => {
  const buf = term.buffer.active
  const lines = Array.from({ length: term.rows }, (_, y) => {
    const line = buf.getLine(buf.viewportY + y)
    const spans: Array<Span> = []
    for (let x = 0; x < term.cols; x++) {
      const c = line?.getCell(x)
      if (c !== undefined && c.getWidth() === 0) continue
      let fg = c === undefined ? undefined : colour(c.isFgPalette(), c.isFgRGB(), c.getFgColor())
      let bg = c === undefined ? undefined : colour(c.isBgPalette(), c.isBgRGB(), c.getBgColor())
      if (c !== undefined && c.isInverse() !== 0) [fg, bg] = [bg ?? BG, fg ?? FG]
      const look: Omit<Span, "t" | "cells"> = {
        ...(fg === undefined ? {} : { fg }),
        ...(bg === undefined ? {} : { bg }),
        ...(c?.isBold() ? { b: true as const } : {}),
        ...(c?.isItalic() ? { i: true as const } : {}),
        ...(c?.isUnderline() ? { u: true as const } : {}),
        ...(c?.isDim() ? { d: true as const } : {}),
      }
      const t = c?.getChars() || " "
      const w = c?.getWidth() ?? 1
      const last = spans.at(-1)
      if (last !== undefined && sameLook(last, look)) spans[spans.length - 1] = { ...last, t: last.t + t, cells: last.cells + w }
      else spans.push({ t, ...look, cells: w })
    }
    // Key order fixed (t, then the look, then cells) so the same screen is the same bytes.
    return spans.map(({ t, cells, ...look }) => ({ t, ...look, cells }))
  })
  return { cols: term.cols, rows: term.rows, fg: FG, bg: BG, lines }
}

export const frame = (caption: string, term: XtermLike): Capture => ({ kind: "evidence-terminal/frame", caption, files: { "frame.json": JSON.stringify(frameOf(term)) } })
export const cast = (caption: string, asciicast: string): Capture => ({ kind: "evidence-terminal/cast", caption, files: { "step.cast": asciicast } })

/** A gif of the cast through `agg` (asciinema's gif tool) when it is on PATH; undefined otherwise. */
export const gif = (caption: string, asciicast: string): Capture | undefined => {
  const agg = Bun.which("agg")
  if (agg === null) return undefined
  const dir = mkdtempSync(join(tmpdir(), "zarg-agg-"))
  try {
    writeFileSync(join(dir, "step.cast"), asciicast)
    const p = Bun.spawnSync([agg, join(dir, "step.cast"), join(dir, "step.gif")])
    return p.exitCode === 0 ? { kind: "evidence-terminal/gif", caption, files: { "step.gif": new Uint8Array(readFileSync(join(dir, "step.gif"))) } } : undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
