import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { Kernel } from "@zarg/kernel"
import { fs, fsRead, runCommand, sh } from "../src"

let base = ""
let root = ""
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "zarg-fs-"))
  root = join(base, "repo")
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, ".env.local"), "SECRETX=abc\n")
  writeFileSync(join(base, "outside.txt"), "outside contents\n")
  mkdirSync(join(base, "outdir"))
  writeFileSync(join(base, "outdir", "f.txt"), "outdir contents\n")
  writeFileSync(join(root, "src", "ok.ts"), "fine\n")
  symlinkSync("../.env.local", join(root, "src", "cfg"))
  symlinkSync(join(base, "outside.txt"), join(root, "src", "out"))
  symlinkSync(join(base, "outdir"), join(root, "src", "dir"))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const run = (cells: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Kernel.make({ services: [fs({ root, scope: { paths: ["**"] }, sensitive: [] }), sh({ root, scope: {}, sensitive: [] })] }), (k) =>
        Effect.forEach(cells, (c) => Effect.map(k.run(c), (r) => r.output)),
      ),
    ),
  )

describe("Fs follows no symlink out of bounds", () => {
  // @scenario S-0046
  test("a symlink to an env file is refused", async () => {
    const [out] = await run(['return yield* Fs.read({ path: "src/cfg" })'])
    expect(out).toContain("OutOfScope")
    expect(out).not.toContain("SECRETX")
  })
  test("symlinks to a file or directory outside the repo are refused", async () => {
    const outs = await run(['return yield* Fs.read({ path: "src/out" })', 'return yield* Fs.read({ path: "src/dir/f.txt" })'])
    for (const o of outs) {
      expect(o).toContain("outside the repository")
      expect(o).not.toContain("contents")
    }
  })
  test("writing through a symlinked directory is refused", async () => {
    const [out] = await run(['return yield* Fs.write({ path: "src/dir/new.txt", content: "x" })'])
    expect(out).toContain("outside the repository")
    expect(existsSync(join(base, "outdir", "new.txt"))).toBe(false)
  })
  test("regular files still read", async () => {
    expect((await run(['return yield* Fs.read({ path: "src/ok.ts" })']))[0]).toBe("fine\n")
  })
  test("list never returns paths outside the repo", async () => {
    const [a, b] = await run(['return yield* Fs.list({ glob: "../*" })', `return yield* Fs.list({ glob: ${JSON.stringify(`${base}/*`)} })`])
    expect(a).toBe("[]")
    expect(b).toBe("[]")
  })
})

describe("Sh deadlines", () => {
  test("a command whose child keeps the pipe open still stops at the deadline", async () => {
    const started = Date.now()
    const [out] = await run(['return yield* Sh.run({ command: "sleep 5; echo x", timeoutMs: 500 })'])
    expect(Date.now() - started).toBeLessThan(2500)
    expect(out).toContain('"timedOut": true')
  })
  test("a command's colour codes are stripped: a model and a finding read plain text", async () => {
    const r = await Effect.runPromise(runCommand({ root: mkdtempSync(join(tmpdir(), "zarg-ansi-")), scope: {}, sensitive: [] }, ["bash", "-c", "printf '\\033[31m✗\\033[0m fail\\n' >&2; printf '\\033[1mok\\033[0m'"], 10_000))
    expect(r.stdout).toBe("ok")
    expect(r.stderr.trim()).toBe("✗ fail")
  })
  test("a command that kills itself is not reported as a timeout", async () => {
    const [out] = await run(['return yield* Sh.run({ command: "kill -9 $$", timeoutMs: 5000 })'])
    expect(out).toContain('"timedOut": false')
  })
  test("an interrupted command takes the processes it started with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zarg-kill-"))
    const pidFile = join(dir, "pid")
    const fiber = Effect.runFork(runCommand({ root: dir, scope: {}, sensitive: [] }, ["bash", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], 60_000))
    const until = Date.now() + 5000
    while (!existsSync(pidFile) && Date.now() < until) await Bun.sleep(20)
    const pid = Number(readFileSync(pidFile, "utf8"))
    await Effect.runPromise(Fiber.interrupt(fiber))
    await Bun.sleep(200)
    const alive = (() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })()
    rmSync(dir, { recursive: true, force: true })
    expect(alive).toBe(false)
  })
})

describe("Fs reads outside the repo only through the host's say", () => {
  const handlers = (outside?: (path: string) => Effect.Effect<void, { _tag: string; message: string }>) =>
    fs({ root, scope: { paths: ["**"] }, sensitive: [], ...(outside !== undefined ? { outside } : {}) }).handlers
  const read = (h: ReturnType<typeof handlers>, path: string) => Effect.runPromise(Effect.result(h.read!({ path }) as Effect.Effect<string, { _tag: string }>))

  test("an absolute path outside the repo is read once the host allows its real path", async () => {
    const asked: Array<string> = []
    const r = await read(handlers((p) => Effect.sync(() => void asked.push(p))), join(base, "outside.txt"))
    expect(r).toMatchObject({ _tag: "Success", success: "outside contents\n" })
    expect(asked).toEqual([join(base, "outside.txt")])
  })

  test("the host's refusal is the read's failure; with no host, outside stays out of bounds", async () => {
    const refused = await read(handlers(() => Effect.fail({ _tag: "NotAllowed", message: "denied" })), join(base, "outside.txt"))
    expect(refused).toMatchObject({ _tag: "Failure", failure: { _tag: "NotAllowed" } })
    expect(await read(handlers(), join(base, "outside.txt"))).toMatchObject({ _tag: "Failure", failure: { _tag: "OutOfScope" } })
  })

  test("a relative glob starting with a wildcard is the repository, never outside", async () => {
    const asked: Array<string> = []
    const h = handlers((p) => Effect.sync(() => void asked.push(p)))
    const out = await Effect.runPromise(h.list!({ glob: "**/*.ts" }) as Effect.Effect<ReadonlyArray<string>>)
    expect(out).toContain("src/ok.ts")
    expect(asked).toEqual([])
  })

  test("a glob outside the repo lists absolute paths, once its folder is allowed", async () => {
    const asked: Array<string> = []
    const h = handlers((p) => Effect.sync(() => void asked.push(p)))
    const out = await Effect.runPromise(h.list!({ glob: `${base}/outdir/**/*.txt` }) as Effect.Effect<ReadonlyArray<string>>)
    expect(out).toEqual([join(base, "outdir", "f.txt")])
    expect(asked).toEqual([join(base, "outdir")])
  })
})

describe("read-only Fs without paths in scope", () => {
  test("reads the whole repository (a driver or research agent is not given paths); a read-write Fs still reads nothing", async () => {
    const ro = fsRead({ root, scope: {}, sensitive: [] }).handlers
    expect(await Effect.runPromise(ro.read!({ path: "src/ok.ts" }) as Effect.Effect<string>)).toBe("fine\n")
    expect(await Effect.runPromise(Effect.flip(ro.read!({ path: ".env.local" }) as Effect.Effect<string, { _tag: string }>))).toMatchObject({ _tag: "OutOfScope" })
    const rw = fs({ root, scope: {}, sensitive: [] }).handlers
    expect(await Effect.runPromise(Effect.flip(rw.read!({ path: "src/ok.ts" }) as Effect.Effect<string, { _tag: string }>))).toMatchObject({ _tag: "OutOfScope" })
  })
})

describe("listing past an unreadable folder", () => {
  test("is a typed failure (or skips it), never a crash of the cell", async () => {
    const locked = join(root, "locked")
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      const r = await Effect.runPromise(Effect.exit(fsRead({ root, scope: {}, sensitive: [] }).handlers.list!({ glob: "**" }) as Effect.Effect<ReadonlyArray<string>, { _tag: string }>))
      expect(r._tag === "Success" || (r._tag === "Failure" && JSON.stringify(r.cause).includes("ListFailed"))).toBe(true)
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})
