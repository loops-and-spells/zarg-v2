import type { XtermLike } from "@zarg/evidence-capture-xterm"
import { Terminal } from "@xterm/headless"
import { cli, MAIN, type World } from "./world"

const COLS = 120
const ROWS = 40

export interface Term {
  readonly screen: () => string
  readonly waitFor: (what: string | RegExp, timeoutMs?: number) => Promise<string>
  /** Waits until the screen no longer shows `what`. */
  readonly waitGone: (what: string | RegExp, timeoutMs?: number) => Promise<string>
  /** Moves the selection (with `key`, right by default) to the option labelled `label`, then presses Enter until the question (`gone`, else the option) leaves. */
  readonly choose: (label: string, key?: string, gone?: string | RegExp) => Promise<void>
  readonly type: (text: string) => void
  readonly press: (key: string) => void
  readonly paste: (text: string) => void
  readonly exit: () => Promise<number>
  /** Kills the TUI at once (SIGKILL), as a crash or a closed terminal would: its core is left behind. */
  readonly kill: () => Promise<number>
  /** The session so far as an asciicast v2 document. */
  readonly cast: () => string
  /** Seconds since the session started (the cast's clock). */
  readonly elapsed: () => number
  /** The headless terminal itself (its cells and colours), for frame captures. */
  readonly xterm: XtermLike
}

const NAMED: Readonly<Record<string, string>> = { enter: "\r", esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", space: " ", backspace: "\x7f", "shift+right": "\x1b[1;2C", "shift+left": "\x1b[1;2D", "shift+tab": "\x1b[Z", "alt+up": "\x1b[1;3A", "alt+down": "\x1b[1;3B", "alt+right": "\x1b[1;3C", "alt+left": "\x1b[1;3D" }
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
export const zarg = async (w: World, args: ReadonlyArray<string> = [], opts: { readonly keepCore?: boolean } = {}): Promise<Term> => {
  // A core a previous session in this world left behind would be refused or replaced: stop it first (unless the session joins it, or the step keeps it).
  if (!args.includes("--attach") && opts.keepCore !== true) await cli(w, ["core", "stop"])
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
  const shows = (s: string, what: string | RegExp) => (typeof what === "string" ? s.includes(what) : what.test(s))
  const until = async (what: string | RegExp, present: boolean, timeoutMs: number) => {
    const end = Date.now() + timeoutMs
    for (;;) {
      const s = screen()
      if (shows(s, what) === present) return s
      if (Date.now() > end) throw new Error(`waited ${timeoutMs} ms for ${String(what)}${present ? "" : " to go"}; the screen:\n${s}`)
      await Bun.sleep(50)
    }
  }
  const waitFor = (what: string | RegExp, timeoutMs = 10_000) => until(what, true, timeoutMs)
  // The selected option is drawn after a ›.
  const selected = (label: string) => new RegExp(`›\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  const choose = async (label: string, key = "right", gone?: string | RegExp) => {
    await waitFor(label)
    for (let k = 0; k < 8 && !selected(label).test(screen()); k++) {
      send(keyBytes(key))
      await Bun.sleep(100)
    }
    if (!selected(label).test(screen())) throw new Error(`could not select ${label} with ${key}; the screen:\n${screen()}`)
    // A question just drawn may not take keys yet: Enter again until it leaves (at most 3 times). `gone` names the
    // question itself: the next question can show the same option selected at once.
    const done = gone ?? selected(label)
    for (let k = 0; k < 3 && shows(screen(), done); k++) {
      send(keyBytes("enter"))
      await until(done, false, 1_500).catch(() => undefined)
    }
  }
  return {
    screen,
    waitFor,
    waitGone: (what, timeoutMs = 10_000) => until(what, false, timeoutMs),
    choose,
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
    kill: () => {
      proc.kill(9)
      return proc.exited
    },
    cast: () => [header, ...events].join("\n") + "\n",
    xterm: term as unknown as XtermLike,
    elapsed: () => (performance.now() - started) / 1000,
  }
}
