import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { diff, GraphStore, hash, Snapshot } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { readClaim, startHeadless, stopCore } from "@zarg/client"
import { cardRefs, snapshotAt } from "./git"
import { root } from "./root"

const print = (value: unknown) => Console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))

const k = Flag.Int("k").pipe(Flag.withDefault(3), Flag.withDescription("hops for --focus / neighbors"))
const focus = Flag.String("focus").pipe(Flag.optional, Flag.withDescription("limit to nodes within --k hops of this id"))

const focusSet = (id: Option.Option<string>, hops: number) =>
  Option.match(id, {
    onNone: () => Effect.succeed(undefined),
    onSome: (id) => Effect.map(GraphStore.use((s) => s.snapshot), (snap) => new Set(Snapshot.neighbors(snap, id, hops))),
  })

/** `--expect S-0001@3f2a9c1b0e4d,UX-0003@absent` */
const parseExpect = (raw: Option.Option<string>) =>
  Effect.forEach(
    Option.match(raw, { onNone: () => [], onSome: (s) => s.split(",") }),
    (pair) => {
      const [id, h] = pair.split("@")
      return id && h ? Effect.succeed([id, h] as const) : Effect.fail(new Error(`--expect wants id@hash, got "${pair}"`))
    },
  ).pipe(Effect.map(Object.fromEntries))

const toolList = Command.make("list", {}, () => PluginHost.use((h) => print(h.tools)))

const toolCall = Command.make("call",
  {
    name: Argument.String("name"),
    params: Argument.String("params-json"),
    expect: Flag.String("expect").pipe(Flag.optional, Flag.withDescription("id@hash pairs that must still hold")),
  },
  ({ name, params, expect }) =>
    Effect.gen(function* () {
      const raw = yield* Effect.try({
        try: () => JSON.parse(params) as unknown,
        catch: () => new Error(`params must be JSON, got: ${params}`),
      })
      const expected = yield* parseExpect(expect)
      const result = yield* PluginHost.use((h) => h.call(name, raw, expected))
      yield* print(result)
    }),
)

const tool = Command.make("tool").pipe(Command.withSubcommands([toolList, toolCall]))

const show = Command.make("show", { id: Argument.String("id") }, ({ id }) =>
  Effect.gen(function* () {
    const snap = yield* GraphStore.use((s) => s.snapshot)
    const node = snap.nodes.get(id)
    if (node === undefined) return yield* Effect.fail(new Error(`no node ${id}`))
    const inbound = Snapshot.inbound(snap, id).map((e) => ({ from: e.from, type: e.edge.type }))
    yield* print({ node, hash: hash(node), inbound })
  }),
)

const render = Command.make("render", { focus, k }, (o) =>
  Effect.flatMap(focusSet(o.focus, o.k), (f) => PluginHost.use((h) => Effect.flatMap(h.render(f), print))),
)

// @card UX-0001
const agenda = Command.make("agenda", { focus, k }, (o) =>
  Effect.flatMap(focusSet(o.focus, o.k), (f) => PluginHost.use((h) => Effect.flatMap(h.agenda(f), print))),
)

const lint = Command.make("lint", {}, () => PluginHost.use((h) => Effect.flatMap(h.lint, print)))

const neighbors = Command.make("neighbors", { id: Argument.String("id"), k }, (o) =>
  Effect.flatMap(GraphStore.use((s) => s.snapshot), (snap) => print(Snapshot.neighbors(snap, o.id, o.k))),
)

const code = Command.make("code", { id: Argument.String("id") }, ({ id }) => Effect.flatMap(cardRefs(root, id), print))

const query = Command.make("query").pipe(Command.withSubcommands([neighbors, code]))

// @card UX-0005
const diffCmd = Command.make("diff", { since: Flag.String("since").pipe(Flag.withDescription("git ref")) }, ({ since }) =>
  Effect.gen(function* () {
    const before = yield* snapshotAt(root, since)
    const after = yield* GraphStore.use((s) => s.snapshot)
    yield* print({ ...diff(before.snapshot, after), problems: before.problems })
  }),
)

const coreStart = Command.make(
  "start",
  { headless: Flag.Boolean("headless").pipe(Flag.withDescription("run until `zarg core stop`, detached from this terminal")) },
  ({ headless }) =>
    Effect.gen(function* () {
      if (!headless) return yield* Effect.fail(new Error("only `zarg core start --headless` is supported; `zarg` starts a core for its session"))
      const { coreCommand } = yield* Effect.promise(() => import("./tui/run"))
      const info = yield* startHeadless({ root, command: coreCommand() })
      yield* print({ pid: info.pid, socket: info.socket, mode: info.mode })
    }),
)

const coreStop = Command.make("stop", {}, () => Effect.flatMap(stopCore(root), (stopped) => print({ stopped })))

const coreStatus = Command.make("status", {}, () =>
  Effect.sync(() => readClaim(root)).pipe(
    Effect.flatMap((c) => print(c === undefined ? { running: false } : { running: true, pid: c.pid, mode: c.mode, ready: c.ready === true, driver: c.driver ?? null })),
  ),
)

const core = Command.make("core").pipe(Command.withSubcommands([coreStart, coreStop, coreStatus]))

/** `zarg [--thread <id>] [--focus <node>…]` opens the TUI; the subcommands are the graph tools and core lifecycle. */
export const zarg = Command.make(
  "zarg",
  {
    thread: Flag.String("thread").pipe(Flag.withDefault("main"), Flag.withDescription("driver thread to open")),
    focus: Flag.String("focus").pipe(Flag.atLeast(0), Flag.withDescription("graph node the thread focuses on (repeatable)")),
  },
  ({ thread, focus }) => Effect.flatMap(Effect.promise(() => import("./tui/run")), (m) => m.runTui({ root, threadId: thread, focus })),
).pipe(Command.withSubcommands([tool, show, render, agenda, lint, query, diffCmd, core]))
