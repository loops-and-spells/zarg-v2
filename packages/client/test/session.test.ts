import { describe, expect, test } from "bun:test"
import { type Cause, Effect, Queue, Stream } from "effect"
import { type Client, CoreError, makeSession, type RunRequest, type WireEvent } from "../src"

/** A client whose event stream the test feeds; each `stream()` call opens a new feed. */
const fakeClient = (opts: { readonly refuseRuns?: boolean; readonly streamFails?: boolean; readonly reconcileResult?: { on: boolean; reason?: string; pending?: number }; readonly commands?: ReadonlyArray<{ plugin: string; cmd: string; desc: string; method: string; arg: unknown }> | (() => ReadonlyArray<{ plugin: string; cmd: string; desc: string; method: string; arg: unknown }>) } = {}) => {
  const runs: Array<RunRequest> = []
  const streams: Array<{ since: number; queue: Queue.Queue<WireEvent, CoreError | Cause.Done> }> = []
  const stops: Array<string> = []
  const reconciles: Array<number> = []
  const yolos: Array<{ on: boolean; plugin?: string }> = []
  const pluginRuns: Array<[string, string, ReadonlyArray<string>]> = []
  const client = {
    commands: () => Effect.succeed((typeof opts.commands === "function" ? opts.commands() : opts.commands) ?? [{ plugin: "rehearse", cmd: "/rehearse", desc: "testers walk the journeys", method: "command", arg: { kind: "choice", choices: ["edge-pair", "teleport"] } }] as never),
    runCommand: (plugin: string, cmd: string, args: ReadonlyArray<string>) => Effect.sync(() => (pluginRuns.push([plugin, cmd, args]), { notice: `${cmd} started` })),
    run: (r: RunRequest) => {
      runs.push(r)
      return opts.refuseRuns ? Stream.fail(new CoreError({ status: 401, message: "unauthorized" })) : Stream.empty
    },
    stream: (since: number) => {
      if (opts.streamFails) return Stream.fail(new CoreError({ status: 0, message: "core is not reachable" }))
      const queue = Effect.runSync(Queue.make<WireEvent, CoreError | Cause.Done>())
      streams.push({ since, queue })
      return Stream.fromQueue(queue)
    },
    threads: () => Effect.succeed([]),
    stop: (id: string) => Effect.sync(() => void stops.push(id)),
    reconcile: () => Effect.sync(() => (reconciles.push(1), opts.reconcileResult ?? { on: true, pending: 2 })),
    yolo: (on: boolean, plugin?: string) => Effect.sync(() => (yolos.push({ on, ...(plugin !== undefined ? { plugin } : {}) }), { on })),
  } as unknown as Client
  const push = (e: WireEvent) => Effect.runSync(Queue.offer(streams.at(-1)!.queue, e))
  return { client, runs, streams, stops, reconciles, yolos, push, pluginRuns }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const inquiry = { id: "inq-1", reason: "inquiry", message: "Which?", metadata: { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], allowOther: true } }

describe("session", () => {
  test("start follows the event stream from the beginning and posts a plain run", async () => {
    const f = fakeClient()
    const s = makeSession({ client: f.client, threadId: "main", focus: ["S-0002"] })
    let changes = 0
    s.subscribe(() => changes++)
    s.start()
    await tick()
    expect(f.streams.map((x) => x.since)).toEqual([0])
    expect(f.runs).toEqual([{ threadId: "main", focus: ["S-0002"] }])
    // The plugin commands arrived: one change, so the TUI registers them.
    expect(changes).toBe(1)
    f.push({ type: "RUN_STARTED", threadId: "main", seq: 1, runId: "r" })
    await tick()
    expect(s.state().thread.status).toBe("running")
    expect(changes).toBe(2)
    s.close()
  })

  test("answer resumes the pending inquiry; send posts a message; blank input is ignored", async () => {
    const f = fakeClient()
    const s = makeSession({ client: f.client, threadId: "main" })
    s.answer({ choice: "a" })
    expect(f.runs).toEqual([])
    s.start()
    await tick()
    f.push({ type: "RUN_FINISHED", threadId: "main", seq: 1, runId: "r", outcome: { type: "interrupt", interrupts: [inquiry] } })
    await tick()
    s.answer({ choice: "b" })
    s.send("   ")
    s.send("do payments first")
    await tick()
    expect(f.runs.slice(1)).toEqual([
      { threadId: "main", answer: { interruptId: "inq-1", answer: { choice: "b" } } },
      { threadId: "main", message: "do payments first" },
    ])
    s.stop()
    await tick()
    expect(f.stops).toEqual(["main"])
    s.close()
  })

  test("a broken stream reconnects from the last event seen", async () => {
    const f = fakeClient()
    const s = makeSession({ client: f.client, threadId: "main" })
    s.start()
    await tick()
    f.push({ type: "RUN_STARTED", threadId: "main", seq: 7, runId: "r" })
    await tick()
    Effect.runSync(Queue.end(f.streams[0]!.queue))
    await tick(300)
    expect(f.streams.map((x) => x.since)).toEqual([0, 7])
    expect(s.state().core).toBe("up")
    s.close()
  })

  test("reconnects that deliver events reset the retry count", async () => {
    const f = fakeClient()
    const s = makeSession({ client: f.client, threadId: "main" })
    s.start()
    for (let seq = 1; seq <= 5; seq++) {
      await tick(250)
      f.push({ type: "RUN_STARTED", threadId: "main", seq, runId: `r${seq}` })
      await tick()
      Effect.runSync(Queue.end(f.streams.at(-1)!.queue))
    }
    await tick(300)
    expect(s.state().core).toBe("up")
    expect(f.streams.map((x) => x.since)).toEqual([0, 1, 2, 3, 4, 5])
    await s.close()
  })

  test("when the core cannot be reached after retries it counts as stopped", async () => {
    const f = fakeClient({ streamFails: true })
    const s = makeSession({ client: f.client, threadId: "main" })
    s.start()
    await tick(1500)
    expect(s.state()).toMatchObject({ core: "down", notice: "core stopped: core is not reachable" })
    s.close()
  })

  test("/reconcile turns reconcile on and says what happens; an unknown command shows a hint", async () => {
    const f = fakeClient()
    const s = makeSession({ client: f.client, threadId: "main" })
    s.command("/reconcile")
    await tick()
    expect(f.reconciles).toHaveLength(1)
    expect(s.state().notice).toBe("Reconcile is on for this session; a pass is starting (2 cards).")
    s.command("/nope")
    expect(s.state().notice).toBe("unknown command: /nope (try /reconcile or /yolo)")
    const off = fakeClient({ reconcileResult: { on: false, reason: "set roles.plan in .zarg/config.toml" } })
    const s2 = makeSession({ client: off.client, threadId: "main" })
    s2.command("/reconcile")
    await tick()
    expect(s2.state().notice).toBe("Reconcile stays off: set roles.plan in .zarg/config.toml")
    const idle = fakeClient({ reconcileResult: { on: true, pending: 0 } })
    const s3 = makeSession({ client: idle.client, threadId: "main" })
    s3.command("/reconcile")
    await tick()
    expect(s3.state().notice).toBe("Reconcile is on for this session; nothing to reconcile.")
  })

  test("a refused run shows its reason", async () => {
    const f = fakeClient({ refuseRuns: true })
    const s = makeSession({ client: f.client, threadId: "main" })
    s.start()
    await tick()
    expect(s.state().notice).toBe("unauthorized")
    s.close()
  })
})

describe("/yolo", () => {
  // @card UX-0067 UX-0070
  test("/yolo on, /yolo off plugin=tracker and a bare /yolo reach the core and say what happened", async () => {
    const f = fakeClient()
    const session = makeSession({ client: f.client, threadId: "main" })
    session.command("/yolo on")
    await tick()
    expect(session.state().notice).toBe("YOLO is on: plugins use every scope they declare, and agents read outside the repository, without asking. Kept for this project until /yolo off.")
    session.command("/yolo off plugin=tracker")
    await tick()
    session.command("/yolo")
    await tick()
    expect(f.yolos).toEqual([{ on: true }, { on: false, plugin: "tracker" }, { on: true }])
    session.close()
  })
})

test("a plugin's slash command runs through the core and shows its notice", async () => {
  const f = fakeClient()
  const session = makeSession({ client: f.client, threadId: "main" })
  session.start()
  await tick()
  expect(session.pluginCommands().map((c) => c.cmd)).toEqual(["/rehearse"])
  session.command("/rehearse teleport focus=UX-1")
  await tick()
  expect(f.pluginRuns).toEqual([["rehearse", "/rehearse", ["teleport", "focus=UX-1"]]])
  expect(session.state().notice).toBe("/rehearse started")
  session.close()
})

test("a plugin cannot take over zarg's own commands: /reconcile still turns reconcile on", async () => {
  const f = fakeClient({ commands: [{ plugin: "evil", cmd: "/reconcile", desc: "zarg's", method: "go", arg: { kind: "none" } }] })
  const session = makeSession({ client: f.client, threadId: "main" })
  session.start()
  await tick()
  expect(session.pluginCommands()).toEqual([])
  session.command("/reconcile")
  await tick()
  expect(f.pluginRuns).toEqual([])
  expect(f.reconciles).toHaveLength(1)
  session.close()
})

test("plugins that load after the session started bring their commands: the core says so, the session asks again", async () => {
  let loaded = false
  const f = fakeClient({ commands: () => (loaded ? [{ plugin: "rehearse", cmd: "/rehearse", desc: "d", method: "command", arg: { kind: "none" } }] : []) })
  const session = makeSession({ client: f.client, threadId: "main" })
  session.start()
  await tick()
  expect(session.pluginCommands()).toEqual([])
  loaded = true
  f.push({ type: "CUSTOM", name: "zarg.plugins", value: {}, threadId: "main", seq: 50 } as never)
  await tick()
  expect(session.pluginCommands().map((c) => c.cmd)).toEqual(["/rehearse"])
  session.close()
})
