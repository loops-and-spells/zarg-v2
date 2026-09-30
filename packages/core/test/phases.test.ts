import { parse } from "@zarg/frontmatter"
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, Redacted, Stream } from "effect"
import { Model, type StreamEvent } from "@zarg/model"
import { engineLayer, makeFindings, Pass, passLayer, workingGraphTree } from "@zarg/reconcile"
import { Rlm, settings } from "@zarg/rlm"
import { reasonOf, reconcileGate, reconcileSettings, reconcileSpec } from "../src/phases"
import { testAffected, testPlugins } from "./plugins-helper"

const roots: Array<string> = []
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))
const sh = (cwd: string, cmd: string) => {
  const p = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr}`)
  return p.stdout.toString().trim()
}
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const node = (root: string, n: { id: string; [k: string]: unknown }) => write(root, `.zarg/graph/nodes/${n.id}.json`, `${JSON.stringify(n)}\n`)

/** A repo with S-0001 and the given cards (uncommitted, as the driver leaves them). */
const project = (cards: ReadonlyArray<string>) => {
  const r = mkdtempSync(join(tmpdir(), "zarg-phases-"))
  roots.push(r)
  sh(r, "git init -q -b main && git config user.email t@t && git config user.name t && echo hi > README.md && git add -A && git commit -qm init")
  node(r, { id: "S-0001", type: "gherkin/state", props: { text: "the home page is shown" }, edges: [] })
  for (const c of cards) node(r, { id: c, type: "gherkin/card", props: { title: `Card ${c}`, when: `the user does ${c}` }, edges: [{ type: "gherkin/arrives", to: "S-0001" }, { type: "gherkin/then", to: "S-0001" }] })
  return r
}

/** A model that answers by preset (from the system prompt) with the card id substituted into the cell. */
const stub = (cells: Record<string, (card: string) => string>) =>
  Layer.succeed(Model.Model, {
    client: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    info: () => Effect.die("unused"),
    warm: () => Effect.void,
    stream: (req) => {
      const preset = /zarg (\S+) agent/.exec(String(req.messages[0]?.content))?.[1] ?? "?"
      const card = /card (UX-\d+)/.exec(String(req.messages[1]?.content))?.[1] ?? ""
      const code = cells[preset]?.(card) ?? 'yield* Rlm.done({ value: "?" })'
      const events: ReadonlyArray<StreamEvent> = [
        { type: "toolCall", call: { id: `c${Math.random()}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } } },
        { type: "done", finishReason: "tool_calls" },
      ]
      return Stream.fromIterable(events)
    },
  })

const PLAN = "## Approach\\nAdd a module.\\n## Files\\n- src/x.ts — new\\n## Tests\\n- test — works\\n## Depends on\\nnone"
const planner = (card: string) =>
  card === "UX-0002" ? 'yield* Rlm.done({ value: { blocked: "UX-0002 contradicts UX-0001" } })' : `yield* Rlm.done({ value: { plan: "${PLAN}" } })`
const implementer = (card: string) =>
  [
    `yield* Fs.write({ path: "src/${card}.ts", content: "// @card ${card}\\nexport const ok = true\\n" })`,
    // Requirements are read-only downstream: this edit must not survive.
    `yield* Fs.write({ path: ".zarg/graph/nodes/S-0001.json", content: "tampered" })`,
    `yield* Rlm.done({ value: { files: ["src/${card}.ts"], summary: "added" } })`,
  ].join("\n")

const pass = (repo: string, model: Layer.Layer<Model.Model>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const m = yield* Model.Model
      const s = yield* settings({})
      const findings = makeFindings(repo)
      const spec = reconcileSpec({
        repo,
        settings: yield* reconcileSettings({ verify: "test -f src/UX-0001.ts", land_retry_ms: 50, land_attempts: 2 }),
        sensitive: [],
        findings,
        pluginHost: testPlugins(repo),
        affected: testAffected(repo),
        makeRlm: (services, observe) => Rlm.make({ settings: s, services, roles: { plan: "stub:m", implement: "stub:m" }, observe, cellTimeoutMs: 10_000 }).pipe(Effect.provideService(Model.Model, m)),
      })
      const graph = yield* workingGraphTree(repo)
      const base = sh(repo, "git rev-parse HEAD")
      const out = yield* Pass.execute({ graph, branch: "main", base, attempt: 0 }).pipe(
        Effect.provide(passLayer(spec).pipe(Layer.provideMerge(engineLayer(join(mkdtempSync(join(tmpdir(), "zarg-db-")), "cluster.db"))))),
      )
      return { out, findings: findings.list() }
    }).pipe(Effect.provide(model)) as unknown as Effect.Effect<{ out: typeof Pass.successSchema.Type; findings: ReadonlyArray<{ kind: string; about: ReadonlyArray<string> }> }>,
  )

describe("plan and implement phases", () => {
  test("a card gets a plan file and code in one landed commit; requirements stay untouched", async () => {
    const r = project(["UX-0001"])
    const before = readFileSync(join(r, ".zarg/graph/nodes/S-0001.json"), "utf8")
    const { out } = await pass(r, stub({ plan: planner, "implement-card": implementer }))
    expect(out).toMatchObject({ status: "landed", landed: ["UX-0001"] })
    const plan = readFileSync(join(r, ".zarg/plans/UX-0001.md"), "utf8")
    // The plan's data is frontmatter: its card, the card's hash when planned, its title.
    const { data, body } = parse(plan)
    expect(data).toEqual({ card: "UX-0001", hash: expect.stringMatching(/^[0-9a-f]+$/), title: "Card UX-0001" })
    expect(body).toStartWith("# UX-0001 Card UX-0001\n")
    expect(plan).toContain("## Files\n- src/x.ts — new")
    expect(readFileSync(join(r, "src/UX-0001.ts"), "utf8")).toContain(`// ${"@" + "card"} UX-0001`)
    expect(readFileSync(join(r, ".zarg/graph/nodes/S-0001.json"), "utf8")).toBe(before)
    expect(sh(r, "git log -1 --format=%s")).toBe("feat: implement UX-0001")
  }, 60_000)

  test("a card the planner calls contradictory becomes an unplannable finding; the other card lands", async () => {
    const r = project(["UX-0001", "UX-0002"])
    const { out, findings } = await pass(r, stub({ plan: planner, "implement-card": implementer }))
    expect(out).toMatchObject({ status: "landed", landed: ["UX-0001"], failed: ["UX-0002"] })
    expect(findings.map((f) => [f.kind, f.about])).toEqual([["unplannable", ["UX-0002"]]])
    expect(existsSync(join(r, ".zarg/plans/UX-0002.md"))).toBe(false)
  }, 60_000)
})

describe("when reconcile runs", () => {
  const roles = { driver: "a:b", plan: "a:b", implement: "a:b" }
  test("only with a [reconcile] section, both roles and a git repository top", async () => {
    const r = project([])
    const gate = (extra: Record<string, unknown>, rs: Record<string, string>, root = r) => Effect.runPromise(reconcileGate(root, extra, rs))
    expect(await gate({}, roles)).toMatchObject({ on: false, reason: expect.stringContaining("[reconcile]") })
    expect(await gate({ reconcile: {} }, { driver: "a:b" })).toMatchObject({ on: false, reason: expect.stringContaining("roles.plan") })
    expect(await gate({ reconcile: { enabled: false } }, roles)).toMatchObject({ on: false })
    const sub = join(r, "app")
    mkdirSync(sub)
    expect(await gate({ reconcile: {} }, roles, sub)).toMatchObject({ on: false, reason: expect.stringContaining("top of a git repository") })
    expect(await gate({ reconcile: { quiet_ms: 500 } }, roles)).toMatchObject({ on: true, settings: { quietMs: 500 } })
  })
})

describe("reasons sent to the client", () => {
  test("are redacted, and never [object Object]", () => {
    const sensitive = [{ name: "ZT_REASON_SECRET", value: Redacted.make("zt-reason-secret-value") }]
    expect(reasonOf(new Error("verify failed: zt-reason-secret-value"), sensitive)).toBe("verify failed: <redacted:ZT_REASON_SECRET>")
    expect(reasonOf({ _tag: "ConfigError", message: "bad key" }, sensitive)).toBe("bad key")
    expect(reasonOf({ weird: true }, sensitive)).toBe('{"weird":true}')
  })
})
