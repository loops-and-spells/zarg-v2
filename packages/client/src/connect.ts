import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { Data, Effect } from "effect"
import { type CoreInfo, isAlive, readClaim, readInfo } from "./info"

export class CoreStartError extends Data.TaggedError("CoreStartError")<{ readonly message: string }> {}

export interface Connection {
  readonly info: CoreInfo
  /** True when this process started the core as its child; the core stops when this process exits. */
  readonly owned: boolean
  /** Stop the core if this process owns it; an attached core keeps running. */
  readonly close: () => Promise<void>
}

/** Start `command --root <root> --mode <mode>`, wait for its `ready` line, or fail with its stderr. */
const start = (root: string, command: ReadonlyArray<string>, mode: "child" | "headless", timeoutMs: number) =>
  Effect.callback<{ info: CoreInfo; stop: () => Promise<void> }, CoreStartError>((resume) => {
    const [bin, ...args] = command
    const proc = spawn(bin!, [...args, "--root", root, "--mode", mode], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: mode === "headless",
      // Bun's default is the environment at startup; pass the current one (tests point ZARG_USER_DIR elsewhere).
      env: process.env,
    })
    let out = ""
    let err = ""
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.kill("SIGTERM")
      resume(Effect.fail(new CoreStartError({ message })))
    }
    const timer = setTimeout(() => fail(`core did not start within ${timeoutMs}ms${err ? `:\n${err}` : ""}`), timeoutMs)
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()))
    proc.on("error", (e) => fail(`core could not start: ${e.message}`))
    proc.on("exit", (code) => fail(`core exited with code ${code}${err ? `:\n${err.trim()}` : ""}`))
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString()
      if (settled || !out.includes("\n")) return
      const info = readInfo(root)
      if (!out.startsWith("ready ") || info === undefined || info.pid !== proc.pid) return fail(`core did not report ready: ${out.trim()}`)
      settled = true
      clearTimeout(timer)
      if (mode === "headless") {
        proc.stdin.end()
        proc.stdout.destroy()
        proc.stderr.destroy()
        proc.unref()
      }
      const exited = new Promise<void>((r) => proc.once("exit", () => r()))
      resume(
        Effect.succeed({
          info,
          stop: async () => {
            proc.stdin.end()
            proc.kill("SIGTERM")
            await exited
          },
        }),
      )
    })
  })

/** Wait while a core holds the project but is still starting (loading config and models). */
const untilStarted = (root: string, timeoutMs: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    for (let c = readClaim(root); c !== undefined && c.ready !== true; c = readClaim(root)) {
      if (Date.now() > deadline) return yield* new CoreStartError({ message: `core (pid ${c.pid}) did not become ready within ${timeoutMs}ms` })
      yield* Effect.sleep(50)
    }
  })

/** Whether `pid` is still this project's core (Linux: its command line names `--root <root>`); a reused pid is someone else's. */
const isCoreOf = (pid: number, root: string) => {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
    const at = args.indexOf("--root")
    return at >= 0 && args[at + 1] === root
  } catch {
    return false
  }
}

/** Stop a core and wait until it is gone; `kill`: one that does not stop in time is killed, when it is still this project's core (an orphan: no session needs it). */
const stopPid = (pid: number, timeoutMs: number, opts: { readonly kill?: { readonly root: string } } = {}) =>
  Effect.gen(function* () {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
    let deadline = Date.now() + timeoutMs
    let killed = false
    while (isAlive(pid)) {
      if (Date.now() > deadline) {
        if (opts.kill === undefined || killed || !isCoreOf(pid, opts.kill.root)) return yield* new CoreStartError({ message: `core (pid ${pid}) did not stop within ${timeoutMs}ms` })
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
        killed = true
        deadline = Date.now() + 5_000
      }
      yield* Effect.sleep(50)
    }
  })

/**
 * One core per session: start this session's own core as a child (it stops when this process exits).
 * A core left behind by a session that is gone (an orphan) is replaced; a live session's core, or a headless one, is refused.
 * `attach`: join the project's running core instead (it keeps running when this process exits).
 * `command` runs zarg-core (for example `[process.execPath, "<path>/main.ts"]`).
 */
export const connect = (opts: { readonly root: string; readonly command: ReadonlyArray<string>; readonly timeoutMs?: number; readonly attach?: boolean }) =>
  Effect.gen(function* () {
    const timeoutMs = opts.timeoutMs ?? 30_000
    // @scenario S-0091
    if (opts.attach === true) {
      yield* untilStarted(opts.root, timeoutMs)
      const live = readInfo(opts.root)
      if (live === undefined) return yield* new CoreStartError({ message: "no zarg core running here; start one with zarg" })
      return { info: live, owned: false, close: async () => {} } satisfies Connection
    }
    // @scenario S-0090
    const claim = readClaim(opts.root)
    if (claim !== undefined) {
      if (claim.mode === "headless") return yield* new CoreStartError({ message: `a headless core runs here (pid ${claim.pid}); zarg --attach to join it, or zarg core stop` })
      if (claim.owner !== undefined && isAlive(claim.owner)) return yield* new CoreStartError({ message: `a zarg session is running here (pid ${claim.pid}); zarg --attach to join it, or quit it first` })
      // @scenario S-0089
      // Its session is gone: an orphan, replaced by this session's own core (killed when it will not stop).
      yield* stopPid(claim.pid, 10_000, { kill: { root: opts.root } })
    }
    // @scenario S-0088
    const child = yield* start(opts.root, opts.command, "child", timeoutMs)
    return { info: child.info, owned: true, close: child.stop } satisfies Connection
  })

/** Start a headless core that outlives this process. Fails when a core is already running. */
export const startHeadless = (opts: { readonly root: string; readonly command: ReadonlyArray<string>; readonly timeoutMs?: number }) =>
  Effect.gen(function* () {
    const live = readClaim(opts.root)
    if (live !== undefined) return yield* new CoreStartError({ message: `a core is already running for this project (pid ${live.pid})` })
    return (yield* start(opts.root, opts.command, "headless", opts.timeoutMs ?? 30_000)).info
  })

/** Stop this project's core, whichever process started it. Resolves once it is gone. */
export const stopCore = (root: string, timeoutMs = 10_000) =>
  Effect.gen(function* () {
    const info = readInfo(root)
    if (info === undefined) return false
    process.kill(info.pid, "SIGTERM")
    const deadline = Date.now() + timeoutMs
    while (isAlive(info.pid)) {
      if (Date.now() > deadline) return yield* new CoreStartError({ message: `core (pid ${info.pid}) did not stop within ${timeoutMs}ms` })
      yield* Effect.sleep(50)
    }
    return true
  })
