import type { XtermLike } from "@zarg/evidence-capture-xterm"
import { Terminal } from "@xterm/headless"
import { cli, MAIN, type World } from "./world"

const COLS = 120
const ROWS = 40

export interface Term {
  readonly screen: () => string
  readonly waitFor: (what: string | RegExp, timeoutMs?: number) => Promise<string>
  readonly type: (text: string) => void
  readonly press: (key: string) => void
  readonly paste: (text: string) => void
  readonly exit: () => Promise<number>
  /** The session so far as an asciicast v2 document. */
  readonly cast: () => string
  /** The headless terminal itself (its cells and colours), for frame captures. */
  readonly xterm: XtermLike
}

const NAMED: Readonly<Record<string, string>> = { enter: "\r", esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", space: " ", backspace: "\x7f" }
/** A key name as the bytes a terminal sends. */
export const keyBytes = (key: string): string => {
  if (NAMED[key] !== undefined) return NAMED[key]
  const ctrl = /^ctrl\+([a-z])$/.exec(key)
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96)
  const alt = /^alt\+(.)$/.exec(key)
  if (alt) return `\x1b${alt[1]}`
  if (key.length === 1) return key
  throw new Error(`no key named ${key}`)
}

/** zarg's TUI on a real pseudo-terminal, read through a headless xterm, recorded as a cast. */
export const zarg = async (w: World, args: ReadonlyArray<string> = []): Promise<Term> => {
  // A core a previous session in this world left behind would be refused or replaced: stop it first.
  await cli(w, ["core", "stop"])
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  const started = performance.now()
  const events: Array<string> = []
  const decoder = new TextDecoder()
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: w.project,
    env: w.env,
    terminal: {
      cols: COLS,
      rows: ROWS,
      data: (_t, bytes) => {
        const text = decoder.decode(bytes, { stream: true })
        term.write(text)
        events.push(JSON.stringify([Number(((performance.now() - started) / 1000).toFixed(3)), "o", text]))
      },
    },
  })
  const header = JSON.stringify({ version: 2, width: COLS, height: ROWS, timestamp: Math.floor(Date.now() / 1000), env: { TERM: "xterm-256color" } })
  const send = (s: string) => proc.terminal!.write(s)
  const screen = () => {
    const b = term.buffer.active
    return Array.from({ length: ROWS }, (_, y) => b.getLine(b.viewportY + y)?.translateToString(true) ?? "").join("\n")
  }
  const waitFor = async (what: string | RegExp, timeoutMs = 10_000) => {
    const until = Date.now() + timeoutMs
    for (;;) {
      const s = screen()
      if (typeof what === "string" ? s.includes(what) : what.test(s)) return s
      if (Date.now() > until) throw new Error(`waited ${timeoutMs} ms for ${String(what)}; the screen:\n${s}`)
      await Bun.sleep(50)
    }
  }
  return {
    screen,
    waitFor,
    type: (text) => send(text),
    press: (key) => send(keyBytes(key)),
    paste: (text) => send(`\x1b[200~${text}\x1b[201~`),
    exit: async () => {
      send(keyBytes("ctrl+d"))
      const timer = setTimeout(() => proc.kill(), 10_000)
      const code = await proc.exited
      clearTimeout(timer)
      return code
    },
    cast: () => [header, ...events].join("\n") + "\n",
    xterm: term as unknown as XtermLike,
  }
}
