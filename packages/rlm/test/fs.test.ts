import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Kernel } from "@zarg/kernel"
import { fs, sh } from "../src"

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
  test("a command that kills itself is not reported as a timeout", async () => {
    const [out] = await run(['return yield* Sh.run({ command: "kill -9 $$", timeoutMs: 5000 })'])
    expect(out).toContain('"timedOut": false')
  })
})
