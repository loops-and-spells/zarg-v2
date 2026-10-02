import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Exit, Layer, Scope, Stream } from "effect"
import { Model, type StreamEvent } from "@zarg/model"
import { Rlm, settings } from "@zarg/rlm"
import { initial, reduce } from "@zarg/client"
import { makeLog, makeReconcile, reconcileSettings } from "../src"
import { testAffected, testPlugins } from "./plugins-helper"

const roots: Array<string> = []
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))
const sh = (cwd: string, cmd: string) =>
  Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.toString().trim()
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** A model whose planner plans at once and whose implementer takes `implementMs` in a shell command. */
const model = (implementMs: number) =>
  Layer.succeed(Model.Model, {
    client: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    info: () => Effect.die("unused"),
    warm: () => Effect.void,
    stream: (req) => {
      const preset = /zarg (\S+) agent/.exec(String(req.messages[0]?.content))?.[1]
      const code =
        preset === "plan"
          ? 'yield* Rlm.done({ value: { plan: "## Approach\\nx\\n## Files\\n- a — b\\n## Tests\\n- t — t\\n## Depends on\\nnone" } })'
          : `yield* Sh.run({ command: "sleep ${implementMs / 1000}" })\nyield* Fs.write({ path: "src/a.ts", content: "ok" })\nyield* Rlm.done({ value: { files: ["src/a.ts"], summary: "s" } })`
      const events: ReadonlyArray<StreamEvent> = [
        { type: "toolCall", call: { id: `c${Math.random()}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } } },
        { type: "done", finishReason: "tool_calls" },
      ]
      return Stream.fromIterable(events)
    },
  })

const scopes: Array<Scope.Closeable> = []
afterAll(() => Promise.all(scopes.map((s) => Effect.runPromise(Scope.close(s, Exit.void)))))
const start = (repo: string, implementMs: number) =>
  (scopes.push(Effect.runSync(Scope.make())), Effect.runPromise(
    Effect.gen(function* () {
      const m = yield* Model.Model
      const s = yield* settings({})
      const log = yield* makeLog(join(repo, ".zarg", "threads"), (t) => t)
      const reconcile = yield* makeReconcile({
        repo,
        settings: yield* reconcileSettings({ quiet_ms: 100, verify: "true" }),
        log,
        sensitive: [],
        pluginHost: testPlugins(repo),
        affected: testAffected(repo),
        makeRlm: (services, observe) => Rlm.make({ settings: s, services, roles: { plan: "stub:m", implement: "stub:m" }, observe, cellTimeoutMs: 30_000 }).pipe(Effect.provideService(Model.Model, m)),
      })
      return { reconcile, log }
    }).pipe(Effect.provide(model(implementMs)), Effect.provideService(Scope.Scope, scopes.at(-1)!)) as never,
  )) as Promise<{ reconcile: Effect.Success<ReturnType<typeof makeReconcile>>; log: Effect.Success<ReturnType<typeof makeLog>> }>

const project = () => {
  const r = mkdtempSync(join(tmpdir(), "zarg-rec-"))
  roots.push(r)
  sh(r, "git init -q -b main && git config user.email t@t && git config user.name t && printf '.zarg/threads/\\n' > .gitignore && git add -A && git commit -qm init")
  return r
}
const card = (r: string) => {
  write(r, ".zarg/graph/nodes/ST-0001.json", `${JSON.stringify({ id: "ST-0001", type: "gherkin/state", props: { text: "home" }, edges: [] })}\n`)
  write(r, ".zarg/graph/nodes/S-0001.json", `${JSON.stringify({ id: "S-0001", type: "gherkin/card", props: { title: "Open", when: "the user opens it" }, edges: [{ type: "gherkin/arrives", to: "ST-0001" }, { type: "gherkin/then", to: "ST-0001" }] })}\n`)
}
const until = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await Bun.sleep(50)
}

describe("reconcile in the core", () => {
  test("a pass shows on the plan and implement threads and ends with a summary", async () => {
    const r = project()
    const { reconcile, log } = await start(r, 0)
    card(r)
    await until(() => sh(r, "git log -1 --format=%s") === "feat: implement S-0001")
    await until(() => log.all().some((e) => e.threadId === "implement" && e.type === "RUN_FINISHED"))
    const impl = log.all().filter((e) => e.threadId === "implement")
    expect(String(impl[0]?.type)).toBe("RUN_STARTED")
    expect(impl.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)).toEqual([expect.stringMatching(/^Landed S-0001 in [0-9a-f]{7}\.$/)])
    expect(impl.some((e) => e.type === "ACTIVITY_DELTA" && JSON.stringify(e).includes("S-0001:rlm-1"))).toBe(true)
    expect(log.all().some((e) => e.threadId === "plan" && e.type === "ACTIVITY_DELTA")).toBe(true)
    expect(reconcile.threads.map((t) => [t.id, t.status()])).toEqual([["plan", "idle"], ["implement", "idle"]])
    // The client sees each card's RLM tree (ids carry the card, and JSON Pointer paths stay one segment).
    const state = impl.reduce(reduce, initial("implement"))
    expect(Object.keys(state.rlms).some((id) => id.includes("S-0001"))).toBe(true)
  }, 30_000)

  test("a core closed mid-pass leaves no finding; the next start resumes the pass and lands it", async () => {
    const r = project()
    const first = await start(r, 20_000)
    card(r)
    await until(() => first.reconcile.threads[1]!.status() === "running" && first.log.all().some((e) => e.threadId === "implement" && JSON.stringify(e).includes("implement-card")))
    await Effect.runPromise(Scope.close(scopes.at(-1)!, Exit.void))
    expect(first.reconcile.findings.list()).toEqual([])
    const second = await start(r, 0)
    await until(() => sh(r, "git log -1 --format=%s") === "feat: implement S-0001")
    expect(sh(r, "git log -1 --format=%s")).toBe("feat: implement S-0001")
    expect(second.reconcile.findings.list()).toEqual([])
  }, 60_000)

  test("stop on the implement thread interrupts the pass; nothing lands", async () => {
    const r = project()
    const { reconcile, log } = await start(r, 20_000)
    card(r)
    await until(() => reconcile.threads[1]!.status() === "running" && log.all().some((e) => e.threadId === "implement" && JSON.stringify(e).includes("implement-card")))
    await Effect.runPromise(reconcile.threads[1]!.stop)
    await until(() => reconcile.threads[1]!.status() === "idle", 10_000)
    expect(reconcile.threads[1]!.status()).toBe("idle")
    expect(sh(r, "git log -1 --format=%s")).toBe("init")
    expect(log.all().filter((e) => e.threadId === "implement" && e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)).toEqual(["The pass stopped."])
  }, 40_000)
})
