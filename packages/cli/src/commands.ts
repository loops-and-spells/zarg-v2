import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { diff, GraphStore, hash, Snapshot } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { findPlugin, USER_DIR } from "@zarg/core/plugins"
import { type Grant, makeGrants, scopesDigest, warnings } from "@zarg/plugin/runtime"
import { describeScopes, installPlugin } from "@zarg/plugin/server"
import { buildPlugin } from "@zarg/plugin-sdk/tools"
import { readClaim, startHeadless, stopCore } from "@zarg/client"
import { baseTree, CHECKPOINT, git, LEGACY_CHECKPOINT, snapshotAtTree, workingGraphTree } from "@zarg/reconcile"
import { audit as auditOf, summary as auditSummary, tags as auditTags } from "@zarg/audit"
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

// @card UX-0079
const affected = Command.make("affected", {}, () =>
  Effect.gen(function* () {
    const base = yield* baseTree(root)
    const graph = yield* workingGraphTree(root)
    const [before, after] = yield* Effect.all([snapshotAtTree(root, base), snapshotAtTree(root, graph)])
    yield* print({ base, graph, ...(yield* PluginHost.use((h) => h.affected(before, after))) })
  }),
)

// @card UX-0083
const checkpoint = Command.make("checkpoint", {}, () =>
  Effect.gen(function* () {
    const graph = yield* workingGraphTree(root)
    yield* Effect.sync(() => {
      writeFileSync(join(root, CHECKPOINT), `${JSON.stringify({ graph }, null, 2)}\n`)
      rmSync(join(root, LEGACY_CHECKPOINT), { force: true })
    })
    // Stage the graph and the checkpoint together (and the legacy file's removal), ready for the commit.
    yield* git(root, ["add", "-A", "--", ".zarg/graph", CHECKPOINT])
    yield* git(root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", LEGACY_CHECKPOINT])
    yield* print({ graph })
  }),
)

/** Every card against its @card tags: JSON (or --summary), exit 1 on problems; --card for one card. */
const auditCmd = Command.make(
  "audit",
  {
    summary: Flag.Boolean("summary").pipe(Flag.withDefault(false), Flag.withDescription("a line per problem and the counts, for people and CI logs")),
    card: Flag.String("card").pipe(Flag.optional, Flag.withDescription("one card's status and tags")),
  },
  (o) =>
    Effect.gen(function* () {
      const snap = yield* GraphStore.use((s) => s.snapshot)
      const report = auditOf(snap, yield* auditTags(root))
      if (Option.isSome(o.card)) {
        const id = o.card.value
        return yield* print(report.cards.find((c) => c.id === id) ?? { id, missing: true })
      }
      yield* print(o.summary ? auditSummary(report) : report)
      if (report.problems.length > 0)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
    }),
)

const coreStart = Command.make(
  "start",
  {
    headless: Flag.Boolean("headless").pipe(Flag.withDescription("run until `zarg core stop`, detached from this terminal")),
    yolo: Flag.Boolean("yolo").pipe(Flag.withDefault(false), Flag.withDescription("plugins use every scope they declare without asking (nothing saved)")),
  },
  ({ headless, yolo }) =>
    Effect.gen(function* () {
      if (!headless) return yield* Effect.fail(new Error("only `zarg core start --headless` is supported; `zarg` starts a core for its session"))
      const { coreCommand } = yield* Effect.promise(() => import("./tui/run"))
      const info = yield* startHeadless({ root, command: [...coreCommand(), ...(yolo ? ["--yolo"] : [])] })
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

// A path grant covers a file as given, or everything under a directory (`/mnt/data` → `/mnt/data/**`).
const pathGlob = (p: string) => {
  if (p.includes("*")) return p
  const abs = resolve(p.startsWith("~/") ? `${process.env.HOME ?? ""}${p.slice(1)}` : p)
  return existsSync(abs) && statSync(abs).isFile() ? abs : `${abs}/**`
}

/** The terminal answer to a yes/no question (the CLI has no thread to ask on). */
const confirm = (question: string) =>
  Effect.promise(async () => {
    process.stdout.write(`${question} [y/N] `)
    for await (const line of console) return /^y(es)?$/i.test(line.trim())
    return false
  })

const pluginAdd = Command.make("add", { source: Argument.String("source") }, ({ source }) =>
  Effect.flatMap(installPlugin(resolve(source), USER_DIR), (r) =>
    print({ installed: r.name, dir: r.dir, next: `list it in .zarg/config.toml as [plugins.${r.name}] source = ${JSON.stringify(source)}, then approve it with \`zarg plugin grant ${r.name}\`` }),
  ),
)

const pluginGrant = Command.make(
  "grant",
  {
    name: Argument.String("name"),
    fsRead: Flag.String("fs-read").pipe(Flag.atLeast(0), Flag.withDescription("let it read this file or directory")),
    fsWrite: Flag.String("fs-write").pipe(Flag.atLeast(0), Flag.withDescription("let it write this file or directory")),
    net: Flag.String("net").pipe(Flag.atLeast(0), Flag.withDescription("let it reach this host (https)")),
    secret: Flag.String("secret").pipe(Flag.atLeast(0), Flag.withDescription("let it read this secret of its own namespace")),
  },
  (o) =>
    Effect.gen(function* () {
      const plugin = yield* findPlugin(o.name)
      const m = plugin.manifest
      const grants = yield* makeGrants({ file: join(USER_DIR, "grants.json"), project: root })
      const extra: ReadonlyArray<Grant> = [
        ...o.fsRead.map((p): Grant => ({ kind: "fs-read", glob: pathGlob(p) })),
        ...o.fsWrite.map((p): Grant => ({ kind: "fs-write", glob: pathGlob(p) })),
        ...o.net.map((h): Grant => ({ kind: "net", host: h })),
        ...o.secret.map((k): Grant => ({ kind: "secret", name: k })),
      ]
      if (extra.length > 0) {
        yield* Effect.forEach(extra, (g) => grants.add(m.name, g), { discard: true })
        return yield* print({ plugin: m.name, granted: extra })
      }
      const deps = (m.pluginDependencies ?? []).map((d) => d.name)
      yield* print(`Plugin ${m.name} asks for: ${describeScopes(m)}`)
      for (const w of warnings(m.scopes, m.optional, deps)) yield* print(`Warning: it ${w}.`)
      if (!(yield* confirm("Approve?"))) return yield* print({ plugin: m.name, approved: false })
      yield* grants.approveLoad(m.name, scopesDigest(m.scopes, m.optional, deps))
      yield* print({ plugin: m.name, approved: true })
    }),
)

const pluginBuild = Command.make("build", { dir: Argument.String("dir").pipe(Argument.withDefault(".")) }, ({ dir }) =>
  Effect.gen(function* () {
    const entry = [join(dir, "src/index.ts"), join(dir, "index.ts")].map((p) => resolve(p)).find(existsSync)
    if (entry === undefined) return yield* Effect.fail(new Error(`${dir}: no src/index.ts or index.ts to build`))
    const r = yield* Effect.promise(() => buildPlugin(entry))
    if (!r.ok) return yield* Effect.fail(new Error(r.errors.join("\n")))
    const out = join(resolve(dir), "dist")
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, "zarg-plugin.js"), r.bundle)
    writeFileSync(join(out, "zarg-plugin.json"), `${JSON.stringify(r.manifest, null, 2)}\n`)
    yield* print({ built: r.manifest.name, dir: out, kib: Math.round(r.bundle.length / 1024) })
  }),
)

const plugin = Command.make("plugin").pipe(Command.withSubcommands([pluginAdd, pluginGrant, pluginBuild]))

/** `zarg [--thread <id>] [--focus <node>…]` opens the TUI; the subcommands are the graph tools and core lifecycle. */
export const zarg = Command.make(
  "zarg",
  {
    thread: Flag.String("thread").pipe(Flag.withDefault("main"), Flag.withDescription("driver thread to open")),
    focus: Flag.String("focus").pipe(Flag.atLeast(0), Flag.withDescription("graph node the thread focuses on (repeatable)")),
    yolo: Flag.Boolean("yolo").pipe(Flag.withDefault(false), Flag.withDescription("plugins use every scope they declare without asking, until /yolo off (nothing saved)")),
  },
  ({ thread, focus, yolo }) => Effect.flatMap(Effect.promise(() => import("./tui/run")), (m) => m.runTui({ root, threadId: thread, focus, yolo })),
).pipe(Command.withSubcommands([tool, show, render, agenda, lint, query, diffCmd, affected, checkpoint, auditCmd, core, plugin]))
