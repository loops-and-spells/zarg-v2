import { basename, dirname, join } from "node:path"
import { type CliRenderer, createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect, Layer } from "effect"
import { connect, makeClient, makeSession, type Session } from "@zarg/client"
import { Palette, Theme } from "@zarg/tokens"
import { App, type Meta } from "@zarg/view-tui"

/**
 * The zarg-core command line. Core's entry is resolved as a file path, never imported: the TUI only
 * talks to core over its socket.
 */
export const coreCommand = () => [process.execPath, join(dirname(Bun.resolveSync("@zarg/core", import.meta.dir)), "main.ts")]

export interface Opened {
  readonly session: Session
  readonly meta: Meta
  /** Stop following the core; stops the core too when this process started it. */
  readonly close: () => Promise<void>
}

/** Start this session's own core as a child (or, with `attach`, join the running one) and open a session on one thread. */
export const openSession = (opts: { readonly root: string; readonly threadId: string; readonly focus: ReadonlyArray<string>; readonly command?: ReadonlyArray<string>; readonly attach?: boolean }) =>
  Effect.gen(function* () {
    const conn = yield* connect({ root: opts.root, command: opts.command ?? coreCommand(), ...(opts.attach === true ? { attach: true } : {}) })
    const session = makeSession({ client: makeClient(conn.info), threadId: opts.threadId, focus: opts.focus })
    const meta: Meta = { threadId: opts.threadId, repo: basename(opts.root), mode: conn.info.mode, ...(conn.info.driver !== undefined ? { driver: conn.info.driver } : {}) }
    return {
      session,
      meta,
      close: async () => {
        session.close()
        await conn.close()
      },
    } satisfies Opened
  })

/**
 * Render the app on `renderer` until the renderer is destroyed, then close the session (stopping a child
 * core). Every way out ends there: the exit keys, a signal (OpenTUI destroys the renderer on SIGINT, SIGTERM,
 * SIGHUP) or an app that crashed, since Ctrl-D is also watched below React.
 */
export const mount = (renderer: CliRenderer, opened: Opened, theme?: Theme["Service"]) =>
  new Promise<void>((done) => {
    const exit = () => {
      if (!renderer.isDestroyed) renderer.destroy()
    }
    // Scroll boxes each listen to the renderer (a board has one per lane): no warning printed over the screen.
    renderer.setMaxListeners(1000)
    renderer.once("destroy", () => void opened.close().then(done))
    renderer.keyInput.on("keypress", (key) => {
      if (key.ctrl && key.name === "d") exit()
    })
    createRoot(renderer).render(<App session={opened.session} meta={opened.meta} onExit={exit} {...(theme !== undefined ? { theme } : {})} />)
    opened.session.start()
  })

/** `zarg`: open the TUI on a thread; resolves when the operator exits. */
export const runTui = (opts: { readonly root: string; readonly threadId: string; readonly focus: ReadonlyArray<string>; readonly yolo?: boolean; readonly attach?: boolean }) =>
  Effect.gen(function* () {
    const opened = yield* openSession(opts)
    // --yolo: switched on through the core, so it also works on a core that was already running.
    if (opts.yolo === true) opened.session.command("/yolo on")
    // The terminal's palette: ZARG_THEME_COLORS, else COLORTERM and TERM (read through Effect's Config).
    const theme = yield* Effect.gen(function* () { return yield* Theme }).pipe(Effect.provide(Theme.layer.pipe(Layer.provide(Palette.terminal))), Effect.orDie)
    yield* Effect.promise(async () => mount(await createCliRenderer({ exitOnCtrlC: false, autoFocus: false }), opened, theme))
  })
