import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { type Bound } from "@zarg/kernel"
import { agenda, type CoreContext, DEFAULT_PRESETS, fs, fsRead, inquire, Rlm, type Scope, settings, sh } from "../src"
import { stubModel, type Reply } from "./stub-model"

let root = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "zarg-rlm-"))
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "README.md"), "outside\n")
  writeFileSync(join(root, ".env.local"), "ZT_RLM_KEY=zt-rlm-secret\n")
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const sensitive = [{ name: "ZT_RLM_KEY", value: Redacted.make("zt-rlm-secret") }]
const asked: Array<string> = []
const raised: Array<string> = []

const factory = (name: string, scope: Scope): Bound | undefined => {
  const ctx: CoreContext = { root, scope, sensitive }
  if (name === "Fs") return fs(ctx)
  if (name === "Fs:read") return fsRead(ctx)
  if (name === "Sh") return sh(ctx)
  if (name === "Agenda") return agenda({ raise: (i) => Effect.sync(() => (raised.push(i.title), `A-${raised.length}`)) })
  if (name === "Inquire") return inquire({ ask: (q) => Effect.sync(() => (asked.push(q.question), { choice: q.options[0]!.id })) })
  return undefined
}

const run = (scripts: Record<string, ReadonlyArray<Reply>>, spec: Rlm.RlmSpec, presetsRaw: unknown = {}) => {
  const stub = stubModel(scripts)
  return Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* settings(presetsRaw)
      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", implement: "stub:m" }, cellTimeoutMs: 5000 })
      return yield* Effect.exit(rlm.exec(spec))
    }).pipe(Effect.provide(stub.layer)),
  ).then((exit) => ({ exit, seen: stub.seen }))
}
const ok = <A>(r: { exit: any }) => {
  if (r.exit._tag !== "Success") throw new Error(`expected success, got ${JSON.stringify(r.exit.cause)}`)
  return r.exit.value as Rlm.RlmOutcome
}
const err = (r: { exit: any }) => {
  if (r.exit._tag !== "Failure") throw new Error("expected failure")
  return r.exit.cause.reasons[0].error as Rlm.RlmError
}
const scope: Scope = { paths: ["src/**"] }

describe("Rlm.exec", () => {
  test("a preset whose role has no model fails pointing at /models", async () => {
    const r = await run({}, { task: "t", preset: "plan", scope })
    expect(err(r).message).toBe('no model for role "plan" (set a default with /models)')
  })
  test("runs cells and finishes with a result that matches the preset's Schema", async () => {
    const r = await run(
      { research: [{ cell: 'const t = yield* Fs.read({ path: "src/a.ts" })\nreturn t' }, { cell: 'yield* Rlm.done({ value: { findings: ["a is 1"], sources: ["src/a.ts"] } })' }] },
      { task: "what is a?", preset: "research", scope },
    )
    expect(ok(r)).toMatchObject({ value: { findings: ["a is 1"], sources: ["src/a.ts"] }, turns: 2 })
    const toolMsgs = r.seen[1]!.messages.filter((m) => m.role === "tool")
    expect(toolMsgs[0]?.content).toBe("ok\nexport const a = 1\n")
  })

  test("a result that does not match its Schema is refused, and the model can correct it", async () => {
    const r = await run(
      { research: [{ cell: 'yield* Rlm.done({ value: "just text" })' }, { cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }] },
      { task: "t", preset: "research", scope },
    )
    expect(ok(r).turns).toBe(2)
    expect(r.seen[1]!.messages.at(-1)?.content).toContain("InvalidResult")
  })

  test("a runaway reply (a model looping on its own text) stays out of the conversation, and a turn's tokens are capped", async () => {
    const r = await run({ research: [{ text: `planning ${"дддкк".repeat(20000)} stop` }, { cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }] }, { task: "t", preset: "research", scope })
    expect(ok(r).turns).toBe(2)
    const kept = r.seen[1]!.messages.find((m) => m.role === "assistant")!.content ?? ""
    expect(kept.length).toBeLessThan(5000)
    expect(kept).toStartWith("planning")
    expect(kept).toEndWith("stop")
    expect(r.seen[0]!.maxTokens).toBeGreaterThan(0)
  })

  test("a reply without a tool call gets a nudge", async () => {
    const r = await run({ research: [{ text: "thinking out loud" }, { cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }] }, { task: "t", preset: "research", scope })
    expect(ok(r).turns).toBe(2)
    expect(r.seen[1]!.messages.at(-1)?.content).toContain("Use the exec tool")
  })

  test("running out of turns gives one final report turn, then a budget error", async () => {
    const saved = await run(
      { research: [{ cell: "return 1" }, { cell: "return 2" }, { cell: 'yield* Rlm.done({ value: { findings: ["partial"], sources: [] } })' }] },
      { task: "t", preset: "research", scope, budget: { turns: 2 } },
    )
    expect(ok(saved).value).toEqual({ findings: ["partial"], sources: [] })
    expect(saved.seen[2]!.messages.at(-1)?.content).toContain("budget is exhausted")
    const lost = await run({ research: [{ cell: "return 1" }] }, { task: "t", preset: "research", scope, budget: { turns: 2 } })
    expect(err(lost)).toMatchObject({ kind: "budget" })
  })

  test("a service outside the preset's layer fails the typecheck and never runs", async () => {
    const r = await run(
      { research: [{ cell: 'yield* Sh.run({ command: "echo hi" })' }, { cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }] },
      { task: "t", preset: "research", scope },
    )
    expect(r.seen[1]!.messages.at(-1)?.content).toContain("Cannot find name 'Sh'")
  })
})

describe("spawning", () => {
  test("a child whose graph focus names no node is refused, not started", async () => {
    const events: Array<Rlm.RlmEvent> = []
    const stub = stubModel({
      driver: [
        { cell: 'const r = yield* Effect.catch(Rlm.exec({ task: "find it", preset: "research", scope: { graph: { focus: ["Rehearse", "S-0001"], k: 2 } } }), (e) => Effect.succeed(e.message))\nreturn r' },
        { cell: 'yield* Rlm.done({ value: "ok" })' },
      ],
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* settings({})
        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, cellTimeoutMs: 5000, observe: (e) => events.push(e), unknownIds: (ids) => Effect.succeed(ids.filter((i) => i !== "S-0001")) })
        yield* rlm.exec({ task: "t", preset: "driver", scope: {} })
      }).pipe(Effect.provide(stub.layer)),
    )
    expect(events.filter((e) => e.type === "start").map((e) => e.id)).toEqual(["rlm-1"])
    const step = events.find((e) => e.type === "step" && e.cells.length > 0)
    expect(step?.type === "step" && step.cells[0]!.output).toContain("no node Rehearse")
  })
})

describe("observe", () => {
  test("reports each turn's text, cells and outputs, and the task an RLM started with", async () => {
    const events: Array<Rlm.RlmEvent> = []
    const stub = stubModel({ driver: [{ text: "thinking out loud" }, { cell: 'console.log("hi")' }, { cell: 'yield* Rlm.done({ value: "ok" })' }] })
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* settings({})
        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, cellTimeoutMs: 5000, observe: (e) => events.push(e) })
        yield* rlm.exec({ task: "say hi", preset: "driver", scope: {} })
      }).pipe(Effect.provide(stub.layer)),
    )
    expect(events[0]).toMatchObject({ type: "start", task: "say hi" })
    const steps = events.filter((e) => e.type === "step")
    const ms = expect.any(Number)
    expect(steps).toEqual([
      { type: "step", id: "rlm-1", turn: 1, text: "thinking out loud", cells: [] },
      { type: "step", id: "rlm-1", turn: 2, text: "", cells: [{ code: 'console.log("hi")', ok: true, output: "hi", ms, cell: 1 }] },
      { type: "step", id: "rlm-1", turn: 3, text: "", cells: [{ code: 'yield* Rlm.done({ value: "ok" })', ok: true, output: "", ms, cell: 2 }] },
    ])
    for (const m of events) if (m.type === "model") expect(m.firstTokenMs).toBeLessThanOrEqual(m.modelMs)
  })


  test("the model's timing is reported as soon as the call returns, before a cell that may wait on the developer", async () => {
    const events: Array<Rlm.RlmEvent> = []
    const stub = stubModel({ driver: [{ cell: 'yield* Rlm.done({ value: "ok" })' }] })
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* settings({})
        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, cellTimeoutMs: 5000, observe: (e) => events.push(e) })
        yield* rlm.exec({ task: "t", preset: "driver", scope: {} })
      }).pipe(Effect.provide(stub.layer)),
    )
    const kinds = events.map((e) => e.type)
    expect(kinds.indexOf("model")).toBeGreaterThan(kinds.indexOf("turn"))
    expect(kinds.indexOf("model")).toBeLessThan(kinds.indexOf("step"))
    expect(events.find((e) => e.type === "model")).toMatchObject({ id: "rlm-1", turn: 1, firstTokenMs: expect.any(Number), modelMs: expect.any(Number), promptTokens: expect.any(Number), completionTokens: expect.any(Number) })
  })

  test("service calls and clock reads of every cell are reported as records", async () => {
    const events: Array<Rlm.RlmEvent> = []
    const stub = stubModel({ driver: [{ cell: 'const now = yield* Clock.currentTimeMillis\nyield* Rlm.done({ value: String(now > 0) })' }] })
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* settings({})
        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, cellTimeoutMs: 5000, observe: (e) => events.push(e) })
        yield* rlm.exec({ task: "t", preset: "driver", scope: {} })
      }).pipe(Effect.provide(stub.layer)),
    )
    const records = events.flatMap((e) => (e.type === "record" ? [e.record] : []))
    expect(records.some((r) => r.kind === "tick" && r.source === "clock")).toBe(true)
    expect(records.some((r) => r.kind === "call" && r.service === "Rlm" && r.method === "done")).toBe(true)
    expect(events.find((e) => e.type === "record")).toMatchObject({ id: "rlm-1", turn: 1 })
    // Each step cell names the kernel cell its records carry, so a record ties back to its code.
    const step = events.find((e) => e.type === "step")
    expect(step?.type === "step" && step.cells[0]?.cell).toBe(records[0]!.cell)
  })

  test("a preset with reasoning off asks the model not to think; others leave it to the model", async () => {
    const stub = stubModel({
      driver: [{ cell: 'return yield* Rlm.exec({ task: "find", preset: "research", scope: {} })' }, { cell: 'yield* Rlm.done({ value: "ok" })' }],
      research: [{ cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }],
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* settings({})
        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, cellTimeoutMs: 5000 })
        yield* rlm.exec({ task: "t", preset: "driver", scope: {} })
      }).pipe(Effect.provide(stub.layer)),
    )
    expect(stub.seen.filter((r) => r.preset === "driver").map((r) => r.reasoning)).toEqual([{ enabled: false }, { enabled: false }])
    expect(stub.seen.filter((r) => r.preset === "research").map((r) => r.reasoning)).toEqual([undefined])
  })

  test("reports start, turns and end for each RLM, including children and failures", async () => {
    const events: Array<Rlm.RlmEvent> = []
    const stub = stubModel({
      driver: [{ cell: 'return yield* Rlm.exec({ task: "find", preset: "research", scope: {} })' }, { cell: 'yield* Rlm.done({ value: "ok" })' }],
      research: [{ cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }],
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* settings({})
        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, cellTimeoutMs: 5000, observe: (e) => events.push(e) })
        yield* rlm.exec({ task: "t", preset: "driver", scope: {} })
      }).pipe(Effect.provide(stub.layer)),
    )
    expect(events.filter((e) => e.type !== "step" && e.type !== "model" && e.type !== "record").map((e) => `${e.type}:${e.id}`)).toEqual(["start:rlm-1", "turn:rlm-1", "start:rlm-2", "turn:rlm-2", "end:rlm-2", "turn:rlm-1", "end:rlm-1"])
    expect(events.find((e) => e.type === "start" && e.id === "rlm-2")).toMatchObject({ type: "start", id: "rlm-2", parent: "rlm-1", preset: "research", depth: 1 })
    expect(events.at(-1)).toMatchObject({ type: "end", ok: true, turns: 2 })

    const failed: Array<Rlm.RlmEvent> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* settings({})
        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, observe: (e) => failed.push(e) })
        yield* Effect.exit(rlm.exec({ task: "t", preset: "research", scope: {}, budget: { turns: 1 } }))
      }).pipe(Effect.provide(stubModel({ research: [{ cell: "return 1" }] }).layer)),
    )
    expect(failed.at(-1)).toMatchObject({ type: "end", ok: false, kind: "budget" })
  })
})

describe("folding into children", () => {
  test("a child runs in its own kernel and the parent sees only its result", async () => {
    const r = await run(
      {
        driver: [
          { cell: 'const found = yield* Rlm.exec({ task: "find a", preset: "research", scope: { paths: ["src/**"] } })\nreturn found' },
          { cell: 'yield* Rlm.done({ value: "folded" })' },
        ],
        research: [{ cell: 'const secretTranscriptMarker = 1\nreturn yield* Fs.read({ path: "src/a.ts" })' }, { cell: 'yield* Rlm.done({ value: { findings: ["child found a"], sources: ["src/a.ts"] } })' }],
      },
      { task: "parent", preset: "driver", scope: {} },
    )
    expect(ok(r).value).toBe("folded")
    const parentTurn2 = r.seen.filter((s) => s.preset === "driver")[1]!.messages
    const parentText = JSON.stringify(parentTurn2)
    expect(parentText).toContain("child found a")
    expect(parentText).not.toContain("secretTranscriptMarker")
  })

  test("the spawn graph refuses a preset the parent may not spawn", async () => {
    const r = await run(
      {
        driver: [
          { cell: 'return yield* Effect.catch(Rlm.exec({ task: "edit code", preset: "implement-scenario", scope: {} }), (e) => Effect.succeed(e.message))' },
          { cell: 'yield* Rlm.done({ value: "ok" })' },
        ],
      },
      { task: "parent", preset: "driver", scope: {} },
    )
    ok(r)
    const out = r.seen.filter((s) => s.preset === "driver")[1]!.messages.at(-1)?.content
    expect(out).toContain('preset "driver" may not spawn "implement-scenario"')
  })

  test("an unknown preset at the root is a spawn error", async () => {
    expect(err(await run({}, { task: "t", preset: "nope", scope: {} }))).toMatchObject({ kind: "spawn" })
  })
})

describe("prompting for folding", () => {
  test("the system prompt lists spawnable presets with result types, the depth, and how context works", async () => {
    const r = await run({ driver: [{ cell: 'yield* Rlm.done({ value: "x" })' }] }, { task: "t", preset: "driver", scope: {} })
    const system = String(r.seen[0]!.messages[0]!.content)
    expect(system).toContain("research → { findings: ReadonlyArray<string>; sources: ReadonlyArray<string> }")
    expect(system).toContain("Depth: 0 of 4")
    expect(system).toContain("A child starts fresh")
    expect(system).toContain("keep results you need in variables")
  })

  test("child results stay whole while old write arguments are trimmed", async () => {
    const big = "y".repeat(3000)
    const r = await run(
      {
        driver: [
          { cell: 'const child = yield* Rlm.exec({ task: "find", preset: "research", scope: {} })\nreturn child' },
          { cell: `return ${JSON.stringify(big)}.length` },
          { cell: "return 1" },
          { cell: "return 2" },
          { cell: "return 3" },
          { cell: "return 4" },
          { cell: 'yield* Rlm.done({ value: "ok" })' },
        ],
        research: [{ cell: `yield* Rlm.done({ value: { findings: [${JSON.stringify("f".repeat(1500))}], sources: [] } })` }],
      },
      { task: "parent", preset: "driver", scope: {} },
    )
    const last = r.seen.filter((s) => s.preset === "driver").at(-1)!.messages
    const text = JSON.stringify(last)
    expect(text).toContain("f".repeat(1500))
    expect(text).not.toContain(big)
  })
})

describe("scoped core services", () => {
  const cellOut = (seen: ReadonlyArray<{ messages: ReadonlyArray<any> }>) => String(seen[1]!.messages.at(-1)?.content)
  const once = (cell: string, preset = "implement-scenario") =>
    run({ [preset]: [{ cell }, { cell: 'yield* Rlm.done({ value: { files: [], summary: "" } })' }] }, { task: "t", preset, scope })

  test("Fs refuses paths outside the scope and env files", async () => {
    expect(cellOut((await once('return yield* Fs.read({ path: "README.md" })')).seen)).toContain("OutOfScope")
    expect(cellOut((await once('return yield* Fs.read({ path: "../../etc/passwd" })')).seen)).toContain("outside the repository")
    const wide = await run({ research: [{ cell: 'return yield* Fs.read({ path: ".env.local" })' }, { cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }] }, { task: "t", preset: "research", scope: { paths: ["**"] } })
    expect(cellOut(wide.seen)).toContain("holds secrets")
  })

  test("Fs writes inside the scope", async () => {
    const r = await once('return yield* Fs.write({ path: "src/new.ts", content: "export {}\\n" })')
    expect(cellOut(r.seen)).toContain('"bytes": 10')
    expect(await Bun.file(join(root, "src", "new.ts")).text()).toBe("export {}\n")
  })

  test("Sh runs without secrets in its environment and redacts them from output", async () => {
    process.env.ZT_RLM_KEY = "zt-rlm-secret"
    const r = await once('return yield* Sh.run({ command: "echo [$ZT_RLM_KEY]; echo zt-rlm-secret" })')
    delete process.env.ZT_RLM_KEY
    const out = cellOut(r.seen)
    expect(out).toContain('"stdout": "[]\\n<redacted:ZT_RLM_KEY>\\n"')
    expect(out).not.toContain("zt-rlm-secret")
  })
})

describe("settings", () => {
  test("config presets override defaults; unknown spawn targets are errors", async () => {
    const s = await Effect.runPromise(settings({ max_depth: 2, presets: { research: { ...DEFAULT_PRESETS.research!, budget: { turns: 3 } } } }))
    expect(s.maxDepth).toBe(2)
    expect(s.presets.research?.budget).toEqual({ turns: 3 })
    const e = await Effect.runPromise(Effect.flip(settings({ presets: { research: { layer: [], role: "driver", spawns: ["ghost"] } } })))
    expect(e.message).toContain('unknown preset "ghost"')
  })
})
