import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Stream } from "effect"
import { makeClient, readInfo } from "@zarg/client"
import { grantFirstParty } from "./plugins-helper"

const main = join(import.meta.dir, "..", "src", "main.ts")
const root = mkdtempSync(join(tmpdir(), "zarg-proc-"))
writeFileSync(join(root, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
// Not about grants: rehearse is allowed already, so no grant question waits on main.
grantFirstParty(root)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const start = async (mode: "child" | "headless") => {
  const proc = Bun.spawn([process.execPath, main, "--root", root, "--mode", mode], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env })
  const reader = proc.stdout.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return { proc, first: new TextDecoder().decode(value) }
}

describe("zarg-core process", () => {
  test("a child core serves its socket with a token, refuses a second core, and exits when stdin closes", async () => {
    const { proc, first } = await start("child")
    expect(first.startsWith("ready ")).toBe(true)
    const info = readInfo(root)!
    expect(info).toMatchObject({ pid: proc.pid, mode: "child" })

    // No [reconcile] section in this project: plan and implement are off, so only the driver thread.
    expect(await Effect.runPromise(makeClient(info).threads())).toEqual([{ id: "main", focus: [], status: "idle" }])
    const denied = await Effect.runPromise(Effect.flip(makeClient({ socket: info.socket, token: "wrong" }).threads()))
    expect(denied.status).toBe(401)

    const second = Bun.spawnSync([process.execPath, main, "--root", root, "--mode", "headless"], { env: process.env })
    expect(second.exitCode).toBe(2)
    expect(second.stderr.toString()).toContain("already running")

    proc.stdin.end()
    expect(await proc.exited).toBe(0)
    expect(readInfo(root)).toBeUndefined()
  }, 20_000)

  test("a core killed without cleanup leaves files behind; the next core starts anyway", async () => {
    const first = await start("child")
    first.proc.kill("SIGKILL")
    await first.proc.exited
    const second = await start("child")
    expect(second.first.startsWith("ready ")).toBe(true)
    expect(await Effect.runPromise(makeClient(readInfo(root)!).threads())).toHaveLength(1)
    second.proc.stdin.end()
    await second.proc.exited
  }, 20_000)

  test("two cores started at once: exactly one serves, the other exits 2", async () => {
    const spawn = () => Bun.spawn([process.execPath, main, "--root", root, "--mode", "child"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env })
    const procs = [spawn(), spawn()]
    const first = (p: (typeof procs)[number]) =>
      p.stdout
        .getReader()
        .read()
        .then(async ({ value }) => (value && new TextDecoder().decode(value).startsWith("ready ") ? "ready" : `exit ${await p.exited}`))
    const outcomes = await Promise.all(procs.map(first))
    expect(outcomes.sort()).toEqual(["exit 2", "ready"])
    for (const p of procs) p.stdin.end()
    await Promise.all(procs.map((p) => p.exited))
  }, 20_000)

  test("stub mode: a run reaches the scripted driver's question; core.json names the driver model", async () => {
    const stub = join(root, "stub.json")
    writeFileSync(stub, JSON.stringify({ cells: ['const a = yield* Inquire.ask({ question: "Stubbed?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] })\nreturn a'] }))
    const proc = Bun.spawn([process.execPath, main, "--root", root, "--mode", "child"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ZARG_CORE_STUB: stub },
    })
    await proc.stdout.getReader().read()
    const info = readInfo(root)!
    expect(info.driver).toBe("stub:scripted")
    const events = await Effect.runPromise(Stream.runCollect(makeClient(info).run({ threadId: "main" })).pipe(Effect.map((c) => [...c])))
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ message: "Stubbed?" }] } })
    proc.stdin.end()
    await proc.exited
  }, 20_000)

  test("a core with a client following its event stream still stops within 2s", async () => {
    const { proc } = await start("headless")
    const info = readInfo(root)!
    const follower = Effect.runFork(Stream.runDrain(makeClient(info).stream(0)))
    await Bun.sleep(200)
    const t0 = Date.now()
    proc.kill("SIGTERM")
    await proc.exited
    expect(Date.now() - t0).toBeLessThan(2000)
    Effect.runFork(Fiber.interrupt(follower))
  }, 20_000)

  test("stub mode: a card written to the graph is planned, implemented and landed as one commit", async () => {
    const project = mkdtempSync(join(tmpdir(), "zarg-proc-reconcile-"))
    const git = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd], { cwd: project, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.toString().trim()
    git("git init -q -b main && git config user.email t@t && git config user.name t")
    writeFileSync(join(project, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
    mkdirSync(join(project, ".zarg"))
    writeFileSync(join(project, ".zarg", "config.toml"), '[reconcile]\nquiet_ms = 200\nverify = "test -f src/UX-0001.ts"\n')
    writeFileSync(join(project, ".gitignore"), ".zarg/run/\n.zarg/threads/\n")
    git("git add -A && git commit -qm init")
    const stub = join(project, "..", `${project.split("/").pop()}-stub.json`)
    writeFileSync(
      stub,
      JSON.stringify({
        cells: [
          'yield* Rlm.done({ value: { plan: "## Approach\\nAdd it.\\n## Files\\n- src/UX-0001.ts — new\\n## Tests\\n- none — stub\\n## Depends on\\nnone" } })',
          'yield* Fs.write({ path: "src/UX-0001.ts", content: "// @card UX-0001\\nexport const ok = true\\n" })\nyield* Rlm.done({ value: { files: ["src/UX-0001.ts"], summary: "added" } })',
        ],
      }),
    )
    const proc = Bun.spawn([process.execPath, main, "--root", project, "--mode", "child"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ZARG_CORE_STUB: stub } })
    await proc.stdout.getReader().read()
    mkdirSync(join(project, ".zarg", "graph", "nodes"), { recursive: true })
    writeFileSync(join(project, ".zarg/graph/nodes/S-0001.json"), `${JSON.stringify({ id: "S-0001", type: "gherkin/state", props: { text: "the home page is shown" }, edges: [] })}\n`)
    writeFileSync(
      join(project, ".zarg/graph/nodes/UX-0001.json"),
      `${JSON.stringify({ id: "UX-0001", type: "gherkin/card", props: { title: "Open home", when: "the user opens the app" }, edges: [{ type: "gherkin/arrives", to: "S-0001" }, { type: "gherkin/then", to: "S-0001" }] })}\n`,
    )
    const until = Date.now() + 30_000
    while (git("git log -1 --format=%s") !== "feat: implement UX-0001" && Date.now() < until) await Bun.sleep(200)
    proc.stdin.end()
    await proc.exited
    expect(git("git log -1 --format=%s")).toBe("feat: implement UX-0001")
    expect(git("git show --name-only --format= HEAD").split("\n").sort()).toEqual([
      ".zarg/graph/nodes/S-0001.json",
      ".zarg/graph/nodes/UX-0001.json",
      ".zarg/plans/UX-0001.md",
      ".zarg/reconciled.json",
      "src/UX-0001.ts",
    ])
    expect(git("git status --porcelain")).toBe("")
    rmSync(project, { recursive: true, force: true })
    rmSync(stub, { force: true })
  }, 60_000)

  test("/reconcile turns plan and implement on for a session when the config leaves them off; outside a git top it says why", async () => {
    const project = mkdtempSync(join(tmpdir(), "zarg-proc-force-"))
    const git = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd], { cwd: project, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.toString().trim()
    git("git init -q -b main && git config user.email t@t && git config user.name t")
    writeFileSync(join(project, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
    mkdirSync(join(project, ".zarg", "graph", "nodes"), { recursive: true })
    writeFileSync(join(project, ".zarg", "config.toml"), '[reconcile]\nenabled = false\nquiet_ms = 200\nverify = "true"\n')
    writeFileSync(join(project, ".gitignore"), ".zarg/run/\n.zarg/threads/\n")
    writeFileSync(join(project, ".zarg/graph/nodes/S-0001.json"), `${JSON.stringify({ id: "S-0001", type: "gherkin/state", props: { text: "home" }, edges: [] })}\n`)
    writeFileSync(join(project, ".zarg/graph/nodes/UX-0001.json"), `${JSON.stringify({ id: "UX-0001", type: "gherkin/card", props: { title: "Open", when: "the user opens it" }, edges: [{ type: "gherkin/arrives", to: "S-0001" }, { type: "gherkin/then", to: "S-0001" }] })}\n`)
    git("git add -A && git commit -qm init")
    const stub = join(project, "..", `${project.split("/").pop()}-stub.json`)
    writeFileSync(stub, JSON.stringify({ cells: ['yield* Rlm.done({ value: { plan: "## Approach\\nx" } })', 'yield* Rlm.done({ value: { files: [], summary: "nothing to write" } })'] }))
    const proc = Bun.spawn([process.execPath, main, "--root", project, "--mode", "child"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ZARG_CORE_STUB: stub } })
    await proc.stdout.getReader().read()
    const client = makeClient(readInfo(project)!)
    expect((await Effect.runPromise(client.threads())).map((t) => t.id)).toEqual(["main"])
    // Pressed twice at once: still one reconciler, one pass.
    const [first, second] = await Promise.all([Effect.runPromise(client.reconcile()), Effect.runPromise(client.reconcile())])
    expect([first.on, second.on]).toEqual([true, true])
    expect((await Effect.runPromise(client.threads())).map((t) => t.id)).toEqual(["main", "plan", "implement"])
    const until = Date.now() + 30_000
    while (git("git log -1 --format=%s") !== "feat: implement UX-0001" && Date.now() < until) await Bun.sleep(200)
    expect(git("git log -1 --format=%s")).toBe("feat: implement UX-0001")
    const passes = new Set(
      readFileSync(join(project, ".zarg/threads/plan.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "RUN_STARTED").map((e) => e.runId),
    )
    expect(passes.size).toBe(1)
    expect(await Effect.runPromise(client.reconcile())).toEqual({ on: true, pending: 0 })
    // A checkout it cannot land on: it says why instead of promising a pass.
    git("git checkout -q --detach")
    const detached = await Effect.runPromise(client.reconcile())
    expect(detached.on).toBe(false)
    expect(detached.reason).toContain("detached")
    proc.stdin.end()
    await proc.exited
    rmSync(project, { recursive: true, force: true })
    rmSync(stub, { force: true })

    // Not a git repository: it says why and stays off.
    const plain = mkdtempSync(join(tmpdir(), "zarg-proc-nogit-"))
    writeFileSync(join(plain, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
    writeFileSync(stub.replace(/-stub.json$/, "-none.json"), JSON.stringify({ cells: ["return 1"] }))
    const p2 = Bun.spawn([process.execPath, main, "--root", plain, "--mode", "child"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ZARG_CORE_STUB: stub.replace(/-stub.json$/, "-none.json") } })
    await p2.stdout.getReader().read()
    const answer = await Effect.runPromise(makeClient(readInfo(plain)!).reconcile())
    expect(answer.on).toBe(false)
    expect(answer.reason).toContain("not the top of a git repository")
    p2.stdin.end()
    await p2.exited
    rmSync(plain, { recursive: true, force: true })
  }, 60_000)

  test("a core that cannot start exits 1 with the reason on stderr and leaves no core.json", () => {
    const broken = mkdtempSync(join(tmpdir(), "zarg-proc-bad-"))
    mkdirSync(join(broken, ".zarg"))
    writeFileSync(join(broken, ".zarg", "config.toml"), "not = [valid toml\n")
    writeFileSync(join(broken, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
    const r = Bun.spawnSync([process.execPath, main, "--root", broken, "--mode", "child"], { stdin: "ignore", env: process.env })
    rmSync(broken, { recursive: true, force: true })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain("invalid TOML")
    expect(readInfo(broken)).toBeUndefined()
  }, 20_000)
})
