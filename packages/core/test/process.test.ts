import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Stream } from "effect"
import { makeClient, readInfo } from "@zarg/client"

const main = join(import.meta.dir, "..", "src", "main.ts")
const root = mkdtempSync(join(tmpdir(), "zarg-proc-"))
writeFileSync(join(root, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
afterAll(() => rmSync(root, { recursive: true, force: true }))

const start = async (mode: "child" | "headless") => {
  const proc = Bun.spawn([process.execPath, main, "--root", root, "--mode", mode], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
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

    expect(await Effect.runPromise(makeClient(info).threads())).toEqual([{ id: "main", focus: [], status: "idle" }])
    const denied = await Effect.runPromise(Effect.flip(makeClient({ socket: info.socket, token: "wrong" }).threads()))
    expect(denied.status).toBe(401)

    const second = Bun.spawnSync([process.execPath, main, "--root", root, "--mode", "headless"])
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
    const spawn = () => Bun.spawn([process.execPath, main, "--root", root, "--mode", "child"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
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

  test("a core that cannot start exits 1 with the reason on stderr and leaves no core.json", () => {
    const broken = mkdtempSync(join(tmpdir(), "zarg-proc-bad-"))
    mkdirSync(join(broken, ".zarg"))
    writeFileSync(join(broken, ".zarg", "config.toml"), "not = [valid toml\n")
    writeFileSync(join(broken, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
    const r = Bun.spawnSync([process.execPath, main, "--root", broken, "--mode", "child"], { stdin: "ignore" })
    rmSync(broken, { recursive: true, force: true })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain("invalid TOML")
    expect(readInfo(broken)).toBeUndefined()
  }, 20_000)
})
