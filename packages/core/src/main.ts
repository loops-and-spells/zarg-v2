#!/usr/bin/env bun
// zarg-core: one per project. `--mode child` (default) exits with its parent; `--mode headless` runs until stopped.
import { randomBytes } from "node:crypto"
import { rmSync, writeSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { runDir } from "@zarg/client"
import { claim, markReady, release } from "./lifecycle"
import { liveCore, liveLayer } from "./live"
import { Actions, api, ArchiveControl, InboxControl, Log, PluginCommands, Prompts, ReconcileControl, SetupControl, Threads, Token, YoloControl } from "./server"

const { values } = parseArgs({ options: { root: { type: "string" }, mode: { type: "string" }, yolo: { type: "boolean" } } })
const root = values.root ?? process.cwd()
const mode = values.mode === "headless" ? "headless" : "child"
const socket = join(runDir(root), "core.sock")
const token = randomBytes(24).toString("hex")
const owner = mode === "child" ? process.ppid : undefined
// Test-only: scripted models instead of real providers (see stubLayer).
const stubFile = process.env.ZARG_CORE_STUB

/** Completes when the parent CLI is gone: its stdin pipe closes or this process is re-parented. */
const parentGone = Effect.callback<void>((resume) => {
  const done = () => resume(Effect.void)
  process.stdin.on("end", done)
  process.stdin.on("close", done)
  process.stdin.resume()
  const timer = setInterval(() => {
    if (process.ppid !== owner) done()
  }, 1000)
  return Effect.sync(() => clearInterval(timer))
})

const info = { pid: process.pid, socket, token, mode, ...(owner !== undefined ? { owner } : {}) } as const

const program = Effect.gen(function* () {
  const claimed = claim(root, info)
  if (!claimed.ok) {
    console.error(claimed.reason)
    return yield* Effect.sync(() => process.exit(2))
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => release(root, process.pid)))
  const core = yield* liveCore(root, { stub: stubFile !== undefined })
  // A core killed without cleanup leaves its socket file; we hold the claim now, so it is safe to remove.
  rmSync(socket, { force: true })
  yield* Layer.build(
    HttpRouter.serve(api, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provide([BunHttpServer.layer({ unix: socket }), Layer.succeed(Threads, core.threads), Layer.succeed(Log, core.log), Layer.succeed(Token, token), Layer.succeed(ReconcileControl, { turnOn: core.turnOn }), Layer.succeed(YoloControl, core.yolo), Layer.succeed(Actions, core.actions), Layer.succeed(PluginCommands, core.commands), Layer.succeed(Prompts, core.prompts), Layer.succeed(InboxControl, core.inbox), Layer.succeed(ArchiveControl, core.archive), Layer.succeed(SetupControl, { open: core.setup.open, openIfNeeded: core.setup.openIfNeeded })]),
    ),
  )
  // Finalizers run in reverse: live streams end first, so the server's graceful stop does not wait on them.
  yield* Effect.addFinalizer(() => core.log.close)
  markReady(root, { ...info, ...(core.driver !== undefined ? { driver: core.driver } : {}) })
  console.log(`ready ${socket}`)
  // SIGINT and SIGTERM interrupt this fiber (runMain); finalizers stop the server and release core.json.
  yield* mode === "child" ? parentGone : Effect.never
}).pipe(Effect.scoped, Effect.provide(liveLayer(root, stubFile, { yolo: values.yolo === true })))

// Exit once finalizers ran, on success too: open handles (stdin, workers) would otherwise keep the process alive.
// A failure is written synchronously first: a piped stderr would lose an async log at process.exit.
BunRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown: (exit, onExit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      const e = Cause.squash(exit.cause)
      writeSync(2, `zarg-core: ${e instanceof Error ? e.message : String(e)}\n`)
    }
    Runtime.defaultTeardown(exit, (code) => {
      onExit(code)
      process.exit(code)
    })
  },
})
