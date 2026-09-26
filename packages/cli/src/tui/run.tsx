import { dirname, join } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import { connect, makeClient, makeSession, type Session } from "@zarg/client"
import { App } from "./app"
import type { Meta } from "./view"

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

/** Attach to the project's core, or start one as a child, and open a session on one thread. */
export const openSession = (opts: { readonly root: string; readonly threadId: string; readonly focus: ReadonlyArray<string>; readonly command?: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const conn = yield* connect({ root: opts.root, command: opts.command ?? coreCommand() })
    const session = makeSession({ client: makeClient(conn.info), threadId: opts.threadId, focus: opts.focus })
    const meta: Meta = { threadId: opts.threadId, mode: conn.info.mode, ...(conn.info.driver !== undefined ? { driver: conn.info.driver } : {}) }
    return {
      session,
      meta,
      close: async () => {
        session.close()
        await conn.close()
      },
    } satisfies Opened
  })

/** `zarg`: open the TUI on a thread; resolves when the developer exits. */
export const runTui = (opts: { readonly root: string; readonly threadId: string; readonly focus: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const opened = yield* openSession(opts)
    yield* Effect.promise(async () => {
      const renderer = await createCliRenderer({ exitOnCtrlC: false })
      await new Promise<void>((done) => {
        const exit = () => {
          renderer.destroy()
          void opened.close().then(done)
        }
        createRoot(renderer).render(<App session={opened.session} meta={opened.meta} onExit={exit} />)
        opened.session.start()
      })
    })
  })
